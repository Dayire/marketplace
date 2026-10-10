/** Synthetic discovery acquisition benchmark (#110 → #118 evidence).
 * Usage: node services/marketplace-backend/bench/discovery.mjs [blocks] [span]
 * Reports throughput, request counts and approximate RPC payload bytes for a
 * bounded state-update walk with deployments every fifth block.
 */
import { Store } from "../src/store.mjs";
import { discoverOnce } from "../src/discovery-scan.mjs";
import { address } from "../src/domain.mjs";

const clamp = (value, low, high) =>
  Number.isFinite(value) && value >= low && value <= high ? value : low;
const blocks = clamp(Number(process.argv[2] ?? 5000), 1, 500000);
const span = clamp(Number(process.argv[3] ?? 2000), 1, 2000);
const CONFIG = { chain: "LOCAL", chainId: "0x1", marketplace: null, collections: [] };
const HASH = (n) => "0x" + (0x70000000 + n).toString(16);
const EMPTY_DIFF = {
  storage_diffs: [],
  deprecated_declared_classes: [],
  declared_classes: [],
  migrated_compiled_classes: [],
  deployed_contracts: [],
  replaced_classes: [],
  nonces: [],
};

let stateRequests = 0,
  blockRequests = 0,
  eventRequests = 0,
  payloadBytes = 0;
const head = blocks - 1;
const rpc = {
  stats: () => ({ stateRequests, blockRequests, eventRequests, payloadBytes }),
  call: async (method, params) => {
    if (method === "starknet_chainId") return "0x1";
    if (method === "starknet_getBlockWithTxHashes") {
      blockRequests++;
      const n = params.block_id === "latest" ? head : params.block_id.block_number;
      if (n < 0 || n > head) {
        const error = new Error("Block not found");
        error.details = { rpcCode: 24 };
        throw error;
      }
      const block = {
        block_number: n,
        block_hash: HASH(n),
        parent_hash: n === 0 ? "0x0" : HASH(n - 1),
        timestamp: 1000 + n,
        status: "ACCEPTED_ON_L2",
        transactions: [],
      };
      payloadBytes += JSON.stringify(block).length;
      return block;
    }
    if (method === "starknet_getStateUpdate") {
      stateRequests++;
      const n = params.block_id.block_number;
      if (n < 0 || n > head) {
        const error = new Error("Block not found");
        error.details = { rpcCode: 24 };
        throw error;
      }
      const update = {
        block_hash: HASH(n),
        old_root: "0x0",
        new_root: "0x1",
        state_diff: {
          ...EMPTY_DIFF,
          deployed_contracts:
            n > 0 && n % 5 === 0
              ? [0, 1].map((k) => ({
                  address: address("0x" + (0xd00000 + n * 4 + k).toString(16)),
                  class_hash: "0x" + (0xc1a55 + (n % 7)).toString(16),
                }))
              : [],
        },
      };
      payloadBytes += JSON.stringify(update).length;
      return update;
    }
    if (method === "starknet_getEvents") {
      eventRequests++;
      return { events: [] };
    }
    throw new Error(`unexpected method ${method}`);
  },
};

const store = new Store(":memory:");
const started = performance.now();
let passes = 0,
  deployed = 0,
  result;
do {
  result = await discoverOnce(store, rpc, CONFIG, {
    span,
    concurrency: 8,
    emitterBudget: 0,
  });
  deployed += result.deployed ?? 0;
  passes++;
  if (passes > 100000) throw new Error("Benchmark did not converge");
} while (!result.caughtUp);
const elapsedMs = performance.now() - started;
const summary = {
  blocks,
  span,
  passes,
  deployed,
  catalogRecords: store.list("catalog_collection").length,
  anchors: store.list("discovery_anchor").length,
  ...rpc.stats(),
  elapsedMs: Math.round(elapsedMs),
  blocksPerSecond: Number(((blocks * 1000) / elapsedMs).toFixed(1)),
  requestsPerSecond: Number(
    (((stateRequests + blockRequests + eventRequests) * 1000) / elapsedMs).toFixed(1),
  ),
  kibPerSecond: Number((payloadBytes / 1024 / (elapsedMs / 1000)).toFixed(1)),
};
console.log(JSON.stringify(summary, null, 2));
store.close();
