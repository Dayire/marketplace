import { test } from "node:test";
import assert from "node:assert/strict";
import { PgStore } from "../../src/postgres/store.mjs";
import { migrate } from "../../src/postgres/migrate.mjs";
import { testDatabase } from "./helpers.mjs";
import { scanOnce } from "../../src/indexer.mjs";
import { enqueueBackfill, runBackfill } from "../../src/backfill.mjs";
import { SELECTORS } from "../../src/decode.mjs";
import { address } from "../../src/domain.mjs";

const A = address("0xa");
const X = address("0xb");
const CLASS = "0x0def1";
const cfg = {
  chainId: "0x1",
  marketplace: null,
  collections: [
    { address: A, startBlock: 0 },
    { address: X, startBlock: 2 },
  ],
};
const hash = (n) => `0x${(100 + n).toString(16)}`;
const transfer = (from, tokenId) => ({
  from_address: from,
  keys: [SELECTORS.Transfer],
  data: ["0x1", "0x2", tokenId, "0"],
});
function harness() {
  return {
    call: async (method, p) => {
      if (method === "starknet_chainId") return "0x1";
      if (method === "starknet_getClassHashAt") return CLASS;
      if (method === "starknet_getClass") return { abi: [] };
      if (method === "starknet_getEvents") {
        const lo = p.filter.from_block.block_number,
          hi = p.filter.to_block.block_number;
        const page = (n, sender, tx, tokenId) =>
          n >= lo && n <= hi
            ? [
                {
                  ...transfer(sender, tokenId),
                  block_number: n,
                  block_hash: hash(n),
                  transaction_hash: tx,
                },
              ]
            : [];
        return {
          events: [...page(1, A, "0xaa", "1"), ...page(3, X, "0xbb", "7")],
        };
      }
      const n = p.block_id === "latest" ? 5 : Number(p.block_id.block_number);
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
                events: [transfer(A, "1")],
              },
            },
          ];
        if (n === 3)
          block.transactions = [
            {
              receipt: {
                transaction_hash: "0xbb",
                execution_status: "SUCCEEDED",
                events: [transfer(X, "7")],
              },
            },
          ];
      }
      return block;
    },
  };
}

test("postgres backfill promotes in place and preserves durable records", async (t) => {
  const database = await testDatabase(t);
  const pool = database.pool();
  await migrate(pool);
  const store = new PgStore(pool);
  const rpc = harness();

  // Live indexing with only A registered, plus a durable application record.
  await scanOnce(store, rpc, { ...cfg, collections: [cfg.collections[0]] });
  const aBefore = await store.get("progress", A);
  assert.equal(aBefore.block, 5);
  await store.put(
    "order",
    "0xdurable",
    {
      id: "0xdurable",
      kind: "listing",
      state: "open",
      maker: A,
      nonce: "1",
      collection: A,
      tokenId: "1",
      currency: "0x0000000000000000000000000000000000000000000000000000000000000001",
      buyerDebit: "100",
      expiry: "0",
      feeBps: 250,
    },
    null,
  );

  // Adding old collection X is gated first — the backfill closes the gate.
  await assert.rejects(
    scanOnce(store, rpc, cfg),
    (error) => error.code === "SOURCE_BACKFILL_REQUIRED",
  );
  const job = await enqueueBackfill(store, cfg, { collection: X, target: 5 });
  const result = await runBackfill(store, rpc, cfg, { window: 2 });
  assert.equal(result.promoted, 1, JSON.stringify(result));

  const x = await store.get("progress", X);
  assert.equal(x.block, 5);
  assert.equal(x.hash, hash(5));
  assert.deepEqual(await store.get("progress", A), aBefore);
  assert.equal(
    await store.get("order", "0xdurable").then((row) => row.tokenId),
    "1",
    "application records survive backfill and promotion",
  );

  // No duplicate canonical rows: 6 blocks, one X activity from block 3.
  const blocks = await store.query("SELECT number FROM chain.blocks");
  assert.equal(blocks.rows.length, 6);
  const activity = await store.query(
    "SELECT body FROM market.activity WHERE body->>'collection' = $1",
    [X],
  );
  assert.equal(activity.rows.length, 1);

  // Overlay replay never regresses the checkpoint, and the normal live scan
  // now accepts the registry without rebuilding A.
  await scanOnce(store, rpc, cfg, {
    window: 2,
    from: 3,
    stopAt: 4,
    scope: [X],
  });
  assert.equal((await store.get("progress", X)).block, 5);
  const live = await scanOnce(store, rpc, cfg);
  assert.equal(live.indexed, 5);
  const promoted = await store.get("backfill_job", job.id);
  assert.equal(promoted.state, "promoted");
  await store.close();
});
