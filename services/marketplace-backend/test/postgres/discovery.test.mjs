import { test } from "node:test";
import assert from "node:assert/strict";
import { PgStore } from "../../src/postgres/store.mjs";
import { migrate } from "../../src/postgres/migrate.mjs";
import { testDatabase } from "./helpers.mjs";
import { discoverOnce } from "../../src/discovery-scan.mjs";
import { discoveryKey } from "../../src/discovery.mjs";
import { collectionKey } from "../../src/collection-catalog.mjs";
import { ApiError, address } from "../../src/domain.mjs";

const CONFIG = { chain: "LOCAL", chainId: "0x1", marketplace: null, collections: [] };
const C = (n) => address("0x" + (0xc00000 + n).toString(16));
const CLASS = (n) => "0x" + (0xd00000 + n).toString(16);
const HASH = (n) => "0x" + (0x700000 + n).toString(16);
const rpcError = (rpcCode, message) =>
  new ApiError("RPC_CONTRACT_ERROR", message, 502, { rpcCode });
const EMPTY_DIFF = {
  storage_diffs: [],
  deprecated_declared_classes: [],
  declared_classes: [],
  migrated_compiled_classes: [],
  deployed_contracts: [],
  replaced_classes: [],
  nonces: [],
};

function harness({ head = 4, stateUpdates = {}, stateHashes = {} }) {
  return {
    call: async (method, params) => {
      if (method === "starknet_chainId") return "0x1";
      if (method === "starknet_getBlockWithTxHashes") {
        const n = params.block_id === "latest" ? head : params.block_id.block_number;
        if (n < 0 || n > head) throw rpcError(24, "Block not found");
        return {
          block_number: n,
          block_hash: stateHashes[n] ?? HASH(n),
          parent_hash: HASH(n - 1),
          timestamp: 1000 + n,
          status: "ACCEPTED_ON_L2",
          transactions: [],
        };
      }
      if (method === "starknet_getStateUpdate") {
        const n = params.block_id.block_number;
        if (n > head) throw rpcError(24, "Block not found");
        return {
          block_hash: stateHashes[n] ?? HASH(n),
          old_root: "0x0",
          new_root: "0x1",
          state_diff: { ...EMPTY_DIFF, ...(stateUpdates[n] ?? {}) },
        };
      }
      if (method === "starknet_getEvents") return { events: [] };
      throw new Error(`unexpected method ${method}`);
    },
  };
}

test("discovery commits catalog facts, anchors and coverage on PostgreSQL", async (t) => {
  const db = await testDatabase(t),
    pool = db.pool();
  await migrate(pool);
  const store = new PgStore(pool);
  const result = await discoverOnce(
    store,
    harness({
      head: 4,
      stateUpdates: { 2: { deployed_contracts: [{ address: C(1), class_hash: CLASS(1) }] } },
    }),
    CONFIG,
    { span: 10 },
  );
  assert.deepEqual({ from: result.from, to: result.to, deployed: result.deployed }, {
    from: 0,
    to: 4,
    deployed: 1,
  });
  const record = await store.get("catalog_collection", collectionKey("0x1", C(1)));
  assert.equal(record.state, "candidate");
  assert.equal(record.deployment.block, 2);
  const coverage = await store.get("source_coverage", discoveryKey("0x1"));
  assert.equal(coverage.block, 4);
  assert.equal(coverage.sourceType, "discovery");
  const anchor = await store.get("discovery_anchor", "2");
  assert.deepEqual(anchor, { block: 2, hash: HASH(2) });
  const again = await discoverOnce(store, harness({ head: 4 }), CONFIG, { span: 10 });
  assert.equal(again.caughtUp, true);
  await store.close();
});

test("rewind removes discovery writes and bumps the replay generation", async (t) => {
  const db = await testDatabase(t),
    pool = db.pool();
  await migrate(pool);
  const store = new PgStore(pool);
  const generation = await store.generation();
  await discoverOnce(
    store,
    harness({
      head: 4,
      stateUpdates: { 2: { deployed_contracts: [{ address: C(1), class_hash: CLASS(1) }] } },
    }),
    CONFIG,
    { span: 10 },
  );
  await store.rewind(1);
  assert.equal(await store.get("catalog_collection", collectionKey("0x1", C(1))), null);
  assert.equal(await store.get("source_coverage", discoveryKey("0x1")), null);
  assert.equal(await store.get("discovery_anchor", "2"), null);
  assert.ok(await store.get("discovery_anchor", "1"), "anchors at/below the ancestor stay");
  assert.equal(await store.generation(), generation + 1);
  await store.close();
});

test("a journal hash conflict rolls the discovery transaction back", async (t) => {
  const db = await testDatabase(t),
    pool = db.pool();
  await migrate(pool);
  const store = new PgStore(pool);
  for (let n = 1; n <= 3; n++)
    await store.applyBlock({
      number: n,
      hash: HASH(n),
      parentHash: HASH(n - 1),
      timestamp: 1000 + n,
      events: [],
      sources: [],
      sourceStarts: {},
    });
  await assert.rejects(
    discoverOnce(
      store,
      harness({
        head: 4,
        stateHashes: { 2: "0xbad02" },
        stateUpdates: { 2: { deployed_contracts: [{ address: C(1), class_hash: CLASS(1) }] } },
      }),
      CONFIG,
      { span: 10 },
    ),
    (error) => error.code === "CHAIN_CONFLICT",
  );
  assert.equal(await store.get("catalog_collection", collectionKey("0x1", C(1))), null);
  assert.equal(await store.get("source_coverage", discoveryKey("0x1")), null);
  assert.equal(await store.get("discovery_anchor", "4"), null);
  await store.close();
});
