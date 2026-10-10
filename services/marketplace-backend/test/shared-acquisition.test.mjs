import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { scanOnce } from "../src/indexer.mjs";
import { SELECTORS } from "../src/decode.mjs";
import { address } from "../src/domain.mjs";
import { collectionKey } from "../src/collection-catalog.mjs";

const COLLECTIONS = ["0xa1", "0xa2", "0xa3"].map(address);
const UNKNOWN = address("0xc1");
const MARKETPLACE = address("0x99");
const hash = (n) => `0x${(100 + n).toString(16)}`;

const transfer = (from, tokenId) => ({
  from_address: from,
  keys: [SELECTORS.Transfer],
  data: ["0x1", "0x2", tokenId, "0"],
});

function harness({ extraEmitters = [], malformed = false, marketEvents = [] } = {}) {
  const calls = { getEvents: 0, receipts: 0, filters: [] };
  const receipts = {
    1: [
      ...COLLECTIONS.map((c, i) =>
        transfer(c, String(i + 1)),
      ),
      ...extraEmitters.map((e) => transfer(e, "9")),
      ...marketEvents,
    ],
  };
  const rpc = {
    calls,
    call: async (method, p) => {
      if (method === "starknet_chainId") return "0x1";
      if (method === "starknet_getClassHashAt") return "0x0def1";
      if (method === "starknet_getClass") return { abi: [] };
      if (method === "starknet_getEvents") {
        calls.getEvents++;
        calls.filters.push(p.filter);
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
          events: [
            ...COLLECTIONS.flatMap((c, i) => page(1, c, "0xf0", String(i + 1))),
            ...extraEmitters.flatMap((e) => page(1, e, "0xf0", "9")),
            ...(malformed
              ? page(1, "zz-not-an-address", "0xf0", "1").map((event) => ({
                  ...event,
                  from_address: "zz-not-an-address",
                }))
              : []),
            ...marketEvents.flatMap((e) =>
              page(1, MARKETPLACE, "0xf0", "1").map((event) => ({
                ...event,
                ...e,
              })),
            ),
          ],
        };
      }
      const n = p.block_id === "latest" ? 2 : Number(p.block_id.block_number);
      const block = {
        block_number: n,
        block_hash: hash(n),
        parent_hash: n === 0 ? "0x0" : hash(n - 1),
        timestamp: 100 + n,
        status: "ACCEPTED_ON_L2",
        transactions: [],
      };
      if (method === "starknet_getBlockWithReceipts") {
        calls.receipts++;
        if (n === 1)
          block.transactions = [
            {
              receipt: {
                transaction_hash: "0xf0",
                execution_status: "SUCCEEDED",
                events: (receipts[1] ?? []).map((event) =>
                  event.from_address
                    ? event
                    : { from_address: MARKETPLACE, ...event },
                ),
              },
            },
          ];
      }
      return block;
    },
  };
  return rpc;
}

const three = {
  chain: "LOCAL",
  chainId: "0x1",
  marketplace: null,
  collections: COLLECTIONS.map((address) => ({
    address,
    startBlock: 0,
  })),
};

test("one shared events scan serves every collection per window", async () => {
  const store = new Store(":memory:");
  const rpc = harness();
  const result = await scanOnce(store, rpc, three, { window: 10 });
  assert.equal(rpc.calls.getEvents, 1, "no per-collection events scans");
  assert.equal(result.eventScans, 1);
  assert.equal(rpc.calls.filters[0].address, undefined, "unfiltered pass");
  assert.equal(result.indexed, 2);
  for (const collection of COLLECTIONS)
    assert.equal(store.get("progress", collection).block, 2);
  assert.equal(result.candidatesCreated, 0);
  assert.equal(result.malformedEmitters, 0);
  store.close();
});

test("unknown emitters become discovery candidates, the marketplace does not", async () => {
  const store = new Store(":memory:");
  // The marketplace is a registered source; its address must never be
  // treated as an unknown emitter candidate (its events are market events).
  const rpc = harness({ extraEmitters: [UNKNOWN] });
  const cfg = { ...three, marketplace: MARKETPLACE, marketplaceStartBlock: 0 };
  const result = await scanOnce(store, rpc, cfg, { window: 10 });
  const candidate = store.get(
    "catalog_collection",
    collectionKey("0x1", UNKNOWN),
  );
  assert.ok(candidate, "unknown emitter recorded");
  assert.equal(candidate.state, "candidate");
  assert.equal(result.unknownEmitters, 1);
  assert.equal(result.candidatesCreated, 1);
  assert.equal(
    store.get("catalog_collection", collectionKey("0x1", MARKETPLACE)),
    null,
    "the marketplace never becomes a candidate",
  );
  // A second scan reuses the existing record instead of duplicating work.
  const again = await scanOnce(store, rpc, cfg, { window: 10 });
  assert.equal(again.candidatesCreated ?? 0, 0, "early-return scans report no new candidates");
  store.close();
});

test("the window event budget fails closed", async () => {
  const store = new Store(":memory:");
  const dense = harness({
    extraEmitters: Array.from({ length: 120 }, (_, i) =>
      address(`0x${(0x1000 + i).toString(16)}`),
    ),
  });
  await assert.rejects(
    scanOnce(store, dense, three, { window: 10, maxWindowEvents: 100 }),
    (error) => error.code === "WINDOW_EVENTS_DENSE",
  );
  const rpc = harness();
  await assert.rejects(
    scanOnce(store, rpc, three, { maxWindowEvents: 99 }),
    (error) => error.code === "INVALID_WINDOW",
    "budget itself is validated",
  );
  store.close();
});

test("malformed emitter identities are isolated while acquisition continues", async () => {
  const store = new Store(":memory:");
  const rpc = harness({ malformed: true, extraEmitters: [UNKNOWN] });
  const result = await scanOnce(store, rpc, three, { window: 10 });
  assert.equal(result.indexed, 2, "scan completed despite malformed data");
  assert.equal(result.malformedEmitters, 1);
  assert.equal(
    store.get("catalog_collection", collectionKey("0x1", UNKNOWN)).state,
    "candidate",
    "healthy emitters still routed",
  );
  store.close();
});
