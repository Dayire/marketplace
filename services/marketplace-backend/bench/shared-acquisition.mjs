/**
 * Shared-acquisition benchmark (#114): measures how acquisition costs scale
 * with the number of registered collections. Budgets are configurable and
 * enforced (exit 1 on violation) so the numbers stay comparable.
 *
 *   node bench/shared-acquisition.mjs [collections] [blocks]
 *   BENCH_MAX_EVENT_SCANS=1 BENCH_MAX_RECEIPT_CALLS=blocks ...
 */
import { Store } from "../src/store.mjs";
import { scanOnce } from "../src/indexer.mjs";
import { SELECTORS } from "../src/decode.mjs";
import { address } from "../src/domain.mjs";

const BLOCKS = Number(process.argv[3] ?? 50);
const SCENARIOS = (process.argv[2] ? [Number(process.argv[2])] : [1, 5, 20, 50]);
const budget = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
};
const BUDGETS = {
  maxEventScans: budget("BENCH_MAX_EVENT_SCANS", 1),
  maxReceiptCalls: budget("BENCH_MAX_RECEIPT_CALLS", BLOCKS + 1),
  maxWritesPerEvent: budget("BENCH_MAX_WRITES_PER_EVENT", 6),
  maxHeapDeltaMb: budget("BENCH_MAX_HEAP_DELTA_MB", 512),
};

const hash = (n) => `0x${(100 + n).toString(16)}`;
const transfer = (from, tokenId) => ({
  from_address: from,
  keys: [SELECTORS.Transfer],
  data: ["0x1", "0x2", tokenId, "0"],
});

function harness(collections) {
  const counters = { eventScans: 0, receiptCalls: 0, acquiredEvents: 0, acquiredBytes: 0 };
  const rpc = {
    counters,
    call: async (method, p) => {
      if (method === "starknet_chainId") return "0x1";
      if (method === "starknet_getClassHashAt") return "0x0def1";
      if (method === "starknet_getClass") return { abi: [] };
      if (method === "starknet_getEvents") {
        counters.eventScans++;
        const lo = p.filter.from_block.block_number,
          hi = p.filter.to_block.block_number;
        const events = [];
        for (let n = Math.max(lo, 1); n <= Math.min(hi, BLOCKS - 1); n++)
          for (const [i, collection] of collections.entries())
            for (let e = 0; e < 2; e++) {
              const event = {
                ...transfer(collection, String(n * 10000 + i * 10 + e)),
                block_number: n,
                block_hash: hash(n),
                transaction_hash: `0x${(n * 1000).toString(16)}`,
              };
              events.push(event);
            }
        counters.acquiredEvents += events.length;
        counters.acquiredBytes += JSON.stringify(events).length;
        return { events };
      }
      const n = p.block_id === "latest" ? BLOCKS : Number(p.block_id.block_number);
      const block = {
        block_number: n,
        block_hash: hash(n),
        parent_hash: n === 0 ? "0x0" : hash(n - 1),
        timestamp: 100 + n,
        status: "ACCEPTED_ON_L2",
        transactions: [],
      };
      if (method === "starknet_getBlockWithReceipts") {
        counters.receiptCalls++;
        if (n >= 1 && n <= BLOCKS - 1)
          block.transactions = [
            {
              receipt: {
                transaction_hash: `0x${(n * 1000).toString(16)}`,
                execution_status: "SUCCEEDED",
                events: collections.flatMap((c, i) =>
                  [0, 1].map((e) => transfer(c, String(n * 10000 + i * 10 + e))),
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

const rows = [];
let failed = false;
for (const count of SCENARIOS) {
  const collections = Array.from({ length: count }, (_, i) =>
    address(`0x${(0xa000 + i).toString(16)}`),
  );
  const config = {
    chain: "BENCH",
    chainId: "0x1",
    marketplace: null,
    collections: collections.map((address) => ({ address, startBlock: 0 })),
  };
  const rpc = harness(collections);
  const store = new Store(":memory:");
  let writes = 0;
  const put = store.put.bind(store);
  store.put = (...args) => {
    writes++;
    return put(...args);
  };
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const result = await scanOnce(store, rpc, config, { window: 100 });
  const wallMs = Number((performance.now() - started).toFixed(1));
  const heapDeltaMb = Number(
    ((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024).toFixed(1),
  );
  store.close();

  const ok =
    rpc.counters.eventScans <= BUDGETS.maxEventScans &&
    rpc.counters.receiptCalls <= BUDGETS.maxReceiptCalls &&
    (rpc.counters.acquiredEvents === 0 ||
      writes / rpc.counters.acquiredEvents <= BUDGETS.maxWritesPerEvent);
  if (!ok) failed = true;
  rows.push({
    collections: count,
    indexed: result.indexed,
    eventScans: rpc.counters.eventScans,
    receiptCalls: rpc.counters.receiptCalls,
    acquiredEvents: rpc.counters.acquiredEvents,
    acquiredMb: Number((rpc.counters.acquiredBytes / 1024 / 1024).toFixed(2)),
    dbWrites: writes,
    writesPerEvent: rpc.counters.acquiredEvents
      ? Number((writes / rpc.counters.acquiredEvents).toFixed(2))
      : 0,
    heapDeltaMb,
    wallMs,
    legacyPerCollectionScans: count,
    ok,
  });
}

const columns = Object.keys(rows[0]);
const widths = Object.fromEntries(
  columns.map((key) => [
    key,
    Math.max(key.length, ...rows.map((row) => String(row[key]).length)),
  ]),
);
console.log(
  columns.map((key) => key.padEnd(widths[key])).join("  "),
);
for (const row of rows)
  console.log(
    columns.map((key) => String(row[key]).padEnd(widths[key])).join("  "),
  );
console.log(
  `\nbudgets: eventScans<=${BUDGETS.maxEventScans} (flat, not per collection), ` +
    `receiptCalls<=${BUDGETS.maxReceiptCalls}, writes/event<=${BUDGETS.maxWritesPerEvent}`,
);
if (failed) {
  console.error("BUDGET VIOLATION");
  process.exit(1);
}
