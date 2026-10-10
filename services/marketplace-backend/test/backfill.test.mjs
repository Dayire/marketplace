import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { scanOnce } from "../src/indexer.mjs";
import { enqueueBackfill, runBackfill } from "../src/backfill.mjs";
import { SELECTORS } from "../src/decode.mjs";
import { address } from "../src/domain.mjs";

const A = address("0xa");
const X = address("0xb");
const CLASS = "0x0def1";

const config = (collections) => ({
  chainId: "0x1",
  marketplace: null,
  collections,
});

/** Blocks 0..5; block 1 carries an A event, block 3 carries an X event. */
function harness({ reorgAt = null } = {}) {
  const hash = (n) =>
    reorgAt !== null && n >= reorgAt
      ? `0x${(7000 + n).toString(16)}`
      : `0x${(100 + n).toString(16)}`;
  const evt = (from, tokenId) => ({
    from_address: from,
    keys: [SELECTORS.Transfer],
    data: ["0x1", "0x2", tokenId, "0"],
  });
  const rpc = {
    call: async (method, p) => {
      if (method === "starknet_chainId") return "0x1";
      if (method === "starknet_getEvents") {
        // Mirror the per-source filter the scanner sends.
        const emitter = p.filter.address ? address(p.filter.address) : null;
        const lo = p.filter.from_block.block_number,
          hi = p.filter.to_block.block_number;
        const page = (n, sender, tx, tokenId) =>
          n >= lo && n <= hi
            ? [
                {
                  ...evt(sender, tokenId),
                  block_number: n,
                  block_hash: hash(n),
                  transaction_hash: tx,
                },
              ]
            : [];
        if (emitter === A) return { events: page(1, A, "0xaa", "1") };
        if (emitter === X) return { events: page(3, X, "0xbb", "7") };
        return { events: [] };
      }
      if (method === "starknet_getClassHashAt") return CLASS;
      if (method === "starknet_getClass") return { abi: [] };
      const n =
        p.block_id === "latest" ? 5 : Number(p.block_id.block_number);
      const block = {
        block_number: n,
        block_hash: hash(n),
        parent_hash: n === 0 ? "0x0" : hash(n - 1),
        timestamp: 100 + n,
        status: "ACCEPTED_ON_L2",
        transactions: [],
      };
      if (method === "starknet_getBlockWithReceipts") {
        if (n === 1)
          block.transactions = [
            {
              receipt: {
                transaction_hash: "0xaa",
                execution_status: "SUCCEEDED",
                events: [evt(A, "1")],
              },
            },
          ];
        if (n === 3)
          block.transactions = [
            {
              receipt: {
                transaction_hash: "0xbb",
                execution_status: "SUCCEEDED",
                events: [evt(X, "7")],
              },
            },
          ];
      }
      return block;
    },
  };
  return { rpc, hash };
}

test("enqueue validates registry identity and canonical anchors", async () => {
  const store = new Store(":memory:");
  const { rpc } = harness();
  await scanOnce(store, rpc, config([{ address: A, startBlock: 0 }]));
  await assert.rejects(
    enqueueBackfill(store, config([{ address: A, startBlock: 0 }]), {
      collection: "0xdead",
      target: 5,
    }),
    (error) => error.code === "BACKFILL_REGISTRY",
  );
  await assert.rejects(
    enqueueBackfill(store, config([{ address: A, startBlock: 0 }]), {
      collection: A,
      target: 99,
    }),
    (error) => error.code === "BACKFILL_ANCHOR",
  );
  const job = await enqueueBackfill(
    store,
    config([{ address: A, startBlock: 0 }]),
    { collection: A, target: 3 },
  );
  assert.equal(job.state, "pending");
  assert.equal(job.targetHash, (await store.canonicalBlock(3)).hash);
  await store.close();
});

test("adding an old collection backfills in place without rebuilding others", async () => {
  const store = new Store(":memory:");
  const { rpc, hash } = harness();
  // Live indexing with only A registered.
  await scanOnce(store, rpc, config([{ address: A, startBlock: 0 }]));
  const aBefore = store.get("progress", A);
  assert.equal(aBefore.block, 5);
  // Register the old collection X (startBlock 2) on the populated database.
  const cfg = config([
    { address: A, startBlock: 0 },
    { address: X, startBlock: 2 },
  ]);
  // The completeness gate blocks a normal live scan first...
  await assert.rejects(
    scanOnce(store, rpc, cfg),
    (error) => error.code === "SOURCE_BACKFILL_REQUIRED",
  );
  // ...which is exactly what the backfill repair closes.
  const job = await enqueueBackfill(store, cfg, { collection: X, target: 5 });
  assert.equal(job.from, 2);
  const result = await runBackfill(store, rpc, cfg, { window: 2 });
  assert.equal(result.promoted, 1, JSON.stringify(result));
  // X now covers the canonical head through an in-place overlay.
  const xProgress = store.get("progress", X);
  assert.equal(xProgress.block, 5);
  assert.equal(xProgress.hash, hash(5));
  // A's checkpoint was untouched by the scoped overlay.
  const aAfter = store.get("progress", A);
  assert.deepEqual(aAfter, aBefore);
  // X's event from block 3 is projected now; no duplicate chain blocks exist.
  const activities = store
    .list("activity")
    .map((row) => row.body ?? row)
    .filter((row) => row.collection === X);
  assert.equal(activities.length, 1, "backfill projected the missing event");
  assert.equal(store.list("backfill_job").length, 1);
  // Durable non-chain state survives the overlay.
  store.put("order", "0xdurable", { id: "0xdurable", kind: "listing" }, null);
  const durable = store.get("order", "0xdurable");
  // The normal live scan passes now — no rebuild of A's history required.
  const live = await scanOnce(store, rpc, cfg);
  assert.equal(live.indexed, 5);
  assert.deepEqual(store.get("order", "0xdurable"), durable);
  assert.deepEqual(store.get("progress", A), aBefore);
  await store.close();
});

test("re-running a promoted backfill is a no-op and progress never regresses", async () => {
  const store = new Store(":memory:");
  const { rpc } = harness();
  const cfg = config([
    { address: A, startBlock: 0 },
    { address: X, startBlock: 2 },
  ]);
  await scanOnce(store, rpc, cfg);
  const job = await enqueueBackfill(store, cfg, { collection: X, target: 5 });
  const first = await runBackfill(store, rpc, cfg);
  assert.equal(first.promoted, 1, JSON.stringify(first));
  const before = store.get("progress", X);
  const rerun = await runBackfill(store, rpc, cfg);
  assert.equal(rerun.jobs.length, 0, "promoted job is not re-run");
  assert.equal(store.get("backfill_job", job.id).state, "promoted");
  assert.deepEqual(store.get("progress", X), before);
  // Manual replay of an overlay block must not move the checkpoint back.
  const replay = await scanOnce(store, rpc, cfg, {
    window: 2,
    from: 3,
    stopAt: 4,
    scope: [X],
  });
  assert.equal(replay.indexed, 4);
  assert.equal(store.get("progress", X).block, 5, "monotonic checkpoint");
  await store.close();
});

test("a failing backfill isolates without freezing the healthy source", async () => {
  const store = new Store(":memory:");
  const { rpc } = harness();
  const cfg = config([
    { address: A, startBlock: 0 },
    { address: X, startBlock: 2 },
  ]);
  await scanOnce(store, rpc, cfg);
  // A target whose anchor is valid now but vanishes under a rewind.
  const job = await enqueueBackfill(store, cfg, { collection: X, target: 4 });
  store.rewind(2); // drops canonical blocks 3..4 and the head
  const result = await runBackfill(store, rpc, cfg);
  assert.equal(result.failed, 1, JSON.stringify(result));
  const failed = store.get("backfill_job", job.id);
  assert.equal(failed.state, "failed");
  assert.match(failed.error, /canonical|head|anchor/i);
  // The healthy source keeps scanning: A's history is untouched and a live
  // scan over the surviving prefix still works for the registered sources.
  assert.equal(store.get("progress", A).block, 2);
  await store.close();
});

test("overlapping backfills are refused while one is active", async () => {
  const store = new Store(":memory:");
  const { rpc } = harness();
  const cfg = config([
    { address: A, startBlock: 0 },
    { address: X, startBlock: 2 },
  ]);
  await scanOnce(store, rpc, cfg);
  const job = await enqueueBackfill(store, cfg, { collection: X, target: 5 });
  await assert.rejects(
    enqueueBackfill(store, cfg, { collection: A, target: 5 }),
    (error) => error.code === "BACKFILL_BUSY",
  );
  const result = await runBackfill(store, rpc, cfg);
  assert.equal(result.promoted, 1);
  // Retry after completion is allowed (job is no longer pending/running).
  const retry = await enqueueBackfill(store, cfg, { collection: X, target: 5 });
  assert.equal(retry.state, "pending");
  assert.equal(store.get("backfill_job", job.id).state, "pending");
  await store.close();
});
