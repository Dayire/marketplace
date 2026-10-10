import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import {
  DISCOVERY_ADDRESS,
  discoveryKey,
  activeClassInterval,
  mergeDiscovery,
  normalizeStateUpdate,
  planDiscoveryRange,
} from "../src/discovery.mjs";
import { discoverOnce, probeStateHistory } from "../src/discovery-scan.mjs";
import { collectionKey, sourceReadiness } from "../src/collection-catalog.mjs";
import { ApiError, address } from "../src/domain.mjs";

const CONFIG = { chain: "LOCAL", chainId: "0x1", marketplace: null, collections: [] };
const CHAIN_ID = "0x1";
const C = (n) => address("0x" + (0xc00000 + n).toString(16));
const CLASS = (n) => "0x" + (0xd00000 + n).toString(16);
const HASH = (n) => "0x" + (0x700000 + n).toString(16);
const recordId = (a) => collectionKey(CHAIN_ID, a);
const coverageId = () => discoveryKey(CHAIN_ID);

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

/** Accepted chain 0..head with state diffs per block and optional event emitters. */
function harness({
  head = 5,
  stateFloor = 0,
  stateUpdates = {},
  emitters = {},
  hashes = {},
  stateHashes = {},
  eventsError = null,
}) {
  const stateRequested = [];
  let eventCalls = 0;
  const blockHash = (n) => hashes[n] ?? HASH(n);
  const stateUpdateHash = (n) => stateHashes[n] ?? blockHash(n);
  const rpc = {
    stateRequested,
    get eventCalls() {
      return eventCalls;
    },
    call: async (method, params) => {
      if (method === "starknet_chainId") return CHAIN_ID;
      if (method === "starknet_getBlockWithTxHashes") {
        const n = params.block_id === "latest" ? head : params.block_id.block_number;
        if (n < 0 || n > head) throw rpcError(24, "Block not found");
        return {
          block_number: n,
          block_hash: blockHash(n),
          parent_hash: n === 0 ? "0x0" : blockHash(n - 1),
          timestamp: 1000 + n,
          status: "ACCEPTED_ON_L2",
          transactions: [],
        };
      }
      if (method === "starknet_getStateUpdate") {
        const n = params.block_id.block_number;
        stateRequested.push(n);
        if (n < stateFloor || n > head) throw rpcError(24, "Block not found");
        const diff = stateUpdates[n];
        return {
          block_hash: stateUpdateHash(n),
          old_root: "0x0",
          new_root: "0x1",
          state_diff: { ...EMPTY_DIFF, ...(diff ?? {}) },
        };
      }
      if (method === "starknet_getEvents") {
        eventCalls++;
        if (eventsError) throw eventsError;
        assert.equal(
          params.filter.address,
          undefined,
          "discovery scans emitters without an address filter",
        );
        const from = params.filter.from_block.block_number,
          to = params.filter.to_block.block_number;
        if (params.filter.continuation_token) return { events: [] };
        const events = [];
        for (const [n, list] of Object.entries(emitters))
          if (Number(n) >= from && Number(n) <= to)
            for (const emitter of list)
              events.push({
                from_address: emitter,
                keys: ["0x1"],
                data: [],
                block_number: Number(n),
                block_hash: blockHash(Number(n)),
                transaction_hash: "0x" + (0xaa00 + Number(n)).toString(16),
              });
        return { events };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return rpc;
}

test("discovery walks state updates, records deployments and is idempotent", async () => {
  const store = new Store(":memory:");
  const rpc = harness({
    head: 4,
    stateUpdates: { 2: { deployed_contracts: [{ address: C(1), class_hash: CLASS(1) }] } },
  });
  const first = await discoverOnce(store, rpc, CONFIG, { span: 10 });
  assert.deepEqual(
    { from: first.from, to: first.to, deployed: first.deployed },
    { from: 0, to: 4, deployed: 1 },
  );
  const record = store.get("catalog_collection", recordId(C(1)));
  assert.equal(record.state, "candidate");
  assert.equal(record.standard, null);
  assert.deepEqual(record.deployment, {
    block: 2,
    hash: HASH(2),
    transactionIndex: null,
    eventIndex: null,
  });
  assert.equal(record.classHistory.length, 1);
  assert.equal(record.classHistory[0].classHash, CLASS(1));
  assert.equal(record.classHistory[0].to, null);
  const coverage = store.get("source_coverage", coverageId());
  assert.equal(coverage.block, 4);
  assert.equal(coverage.hash, HASH(4));
  assert.equal(coverage.startBlock, 0);
  assert.equal(coverage.sourceType, "discovery");
  assert.equal(coverage.mode, "catalog");
  assert.deepEqual(coverage.gaps, []);
  const snapshot = JSON.stringify(store.list("catalog_collection"));
  const before = rpc.stateRequested.length;
  const second = await discoverOnce(store, rpc, CONFIG, { span: 10 });
  assert.equal(second.caughtUp, true);
  assert.equal(rpc.stateRequested.length, before, "no refetch past the checkpoint");
  assert.equal(JSON.stringify(store.list("catalog_collection")), snapshot);
  store.close();
});

test("a class replacement closes the interval and invalidates classification", async () => {
  const store = new Store(":memory:");
  const rpc = harness({
    head: 2,
    stateUpdates: {
      1: { deployed_contracts: [{ address: C(1), class_hash: CLASS(1) }] },
    },
  });
  await discoverOnce(store, rpc, CONFIG, { span: 10 });
  const id = recordId(C(1));
  const classified = {
    ...store.get("catalog_collection", id),
    state: "indexed",
    classification: { standard: "ERC721", evidence: "src5" },
  };
  store.put("catalog_collection", id, classified, 2);
  const later = harness({
    head: 5,
    stateUpdates: {
      1: { deployed_contracts: [{ address: C(1), class_hash: CLASS(1) }] },
      4: { replaced_classes: [{ contract_address: C(1), class_hash: CLASS(2) }] },
    },
  });
  await discoverOnce(store, later, CONFIG, { span: 10, stopAt: 5 });
  const record = store.get("catalog_collection", id);
  assert.equal(record.classHistory.length, 2);
  assert.deepEqual(record.classHistory[0].to, {
    block: 4,
    hash: HASH(4),
    transactionIndex: null,
    eventIndex: null,
  });
  assert.equal(record.classHistory[1].classHash, CLASS(2));
  assert.equal(record.classHistory[1].to, null);
  assert.equal(activeClassInterval(record, 2).classHash, CLASS(1));
  assert.equal(activeClassInterval(record, 4).classHash, CLASS(2));
  assert.equal(record.classification, null, "class change invalidates classification");
  assert.equal(record.state, "candidate");
  store.close();
});

test("empty blocks advance the checkpoint without creating records", async () => {
  const store = new Store(":memory:");
  const result = await discoverOnce(store, harness({ head: 3 }), CONFIG, { span: 10 });
  assert.equal(result.to, 3);
  assert.deepEqual(store.list("catalog_collection"), []);
  assert.equal(store.get("source_coverage", coverageId()).block, 3);
  store.close();
});

test("duplicate discovery input merges idempotently and conflicts are rejected", () => {
  const events = [
    { block: 7, hash: HASH(7), kind: "deploy", classHash: CLASS(3) },
  ];
  const first = mergeDiscovery(null, events);
  const previous = {
    ...first,
    chainId: CHAIN_ID,
    address: C(3),
    id: recordId(C(3)),
    replayGeneration: 1,
  };
  const again = mergeDiscovery(previous, events);
  assert.deepEqual(
    { ...previous, ...again },
    previous,
    "identical input must not change the record",
  );
  const conflicted = mergeDiscovery(previous, [
    { block: 9, hash: HASH(9), kind: "deploy", classHash: CLASS(3) },
  ]);
  assert.equal(conflicted.deployment.block, 7, "first deployment evidence wins");
  assert.throws(
    () =>
      mergeDiscovery(previous, [
        { block: 9, hash: HASH(9), kind: "deploy", classHash: CLASS(4) },
      ]),
    (error) => error instanceof ApiError && error.code === "DISCOVERY_CONFLICT",
    "a different class behind a deploy is only valid as a replacement",
  );
});

test("a restart resumes from the persisted checkpoint without refetching", async () => {
  const dir = mkdtempSync(join(tmpdir(), "discovery-restart-"));
  const path = join(dir, "chain.db");
  try {
    const first = new Store(path);
    const rpc = harness({
      head: 4,
      stateUpdates: { 2: { deployed_contracts: [{ address: C(1), class_hash: CLASS(1) }] } },
    });
    await discoverOnce(first, rpc, CONFIG, { span: 5 });
    first.close();
    const reopened = new Store(path);
    assert.equal(reopened.get("source_coverage", coverageId()).block, 4);
    const resumed = harness({
      head: 7,
      stateUpdates: { 6: { deployed_contracts: [{ address: C(2), class_hash: CLASS(2) }] } },
    });
    const result = await discoverOnce(reopened, resumed, CONFIG, { span: 5 });
    assert.equal(result.from, 5);
    assert.deepEqual(
      resumed.stateRequested.sort((a, b) => a - b),
      [5, 6, 7],
      "only blocks after the checkpoint are fetched",
    );
    assert.ok(reopened.get("catalog_collection", recordId(C(2))));
    assert.ok(reopened.get("catalog_collection", recordId(C(1))));
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reorg rewinds discovery records and re-walks the canonical chain", async () => {
  const store = new Store(":memory:");
  const hashes = {};
  for (let n = 0; n <= 4; n++) hashes[n] = HASH(n);
  const rpc = harness({
    head: 4,
    hashes,
    stateUpdates: { 2: { deployed_contracts: [{ address: C(1), class_hash: CLASS(1) }] } },
  });
  await discoverOnce(store, rpc, CONFIG, { span: 10 });
  const id = recordId(C(1));
  store.put(
    "catalog_collection",
    id,
    {
      ...store.get("catalog_collection", id),
      state: "indexed",
      classification: { standard: "ERC721", evidence: "src5" },
    },
    4,
  );
  const generationBefore = store.generation();
  // Reorg from block 2: new hashes and a different class behind the same address.
  hashes[2] = "0xdead02";
  hashes[3] = "0xdead03";
  hashes[4] = "0xdead04";
  const reorged = harness({
    head: 4,
    hashes,
    stateUpdates: { 2: { deployed_contracts: [{ address: C(1), class_hash: CLASS(9) }] } },
  });
  const result = await discoverOnce(store, reorged, CONFIG, { span: 10 });
  assert.equal(result.rewound, 1, "rewound to the common ancestor block 1");
  assert.equal(store.generation(), generationBefore + 1);
  const record = store.get("catalog_collection", id);
  assert.equal(record.classification, null, "reorg invalidates classification");
  assert.equal(record.classHistory.length, 1);
  assert.equal(record.classHistory[0].classHash, CLASS(9));
  assert.deepEqual(record.deployment, {
    block: 2,
    hash: "0xdead02",
    transactionIndex: null,
    eventIndex: null,
  });
  const coverage = store.get("source_coverage", coverageId());
  assert.equal(coverage.block, 4);
  assert.equal(coverage.hash, "0xdead04");
  store.close();
});

test("a history floor becomes an explicit gap, never claimed completeness", async () => {
  const store = new Store(":memory:");
  const rpc = harness({ head: 60, stateFloor: 20 });
  const result = await discoverOnce(store, rpc, CONFIG, { span: 100, probes: 6 });
  assert.equal(result.to, 60);
  const coverage = store.get("source_coverage", coverageId());
  assert.equal(coverage.startBlock, 0);
  assert.deepEqual(coverage.gaps, [
    { from: 0, to: 19, reason: "STATE_HISTORY_UNAVAILABLE before provider floor block 20" },
  ]);
  const probe = store.get("status", "discovery_probe");
  assert.equal(probe.supported, true);
  assert.equal(probe.floorBlock, 20);
  const readiness = sourceReadiness(
    [{ chainId: CHAIN_ID, address: DISCOVERY_ADDRESS, requiredStartBlock: 0 }],
    [coverage],
    {
      rpc: { head: 60, observedAt: Date.now(), identityVerified: true },
      generation: store.generation(),
      canonicalHashes: { 60: HASH(60) },
    },
  );
  assert.equal(readiness.ready, false);
  assert.ok(readiness.reasons.includes("HISTORY_GAP"));
  // Completeness is only claimed once the floor is probed directly.
  const full = await probeStateHistory(harness({ head: 60, stateFloor: 0 }), {
    earliest: 0,
    head: 60,
    probes: 6,
  });
  assert.equal(full.floorBlock, 0);
  assert.equal(full.gapTo, null);
  store.close();
});

test("pending or malformed state updates are rejected", () => {
  const base = { block_hash: HASH(1), state_diff: { ...EMPTY_DIFF } };
  assert.throws(
    () => normalizeStateUpdate(1, { state_diff: { ...EMPTY_DIFF } }),
    (error) => error.code === "INVALID_STATE_UPDATE",
    "pre-confirmed/pending updates carry no block hash",
  );
  assert.throws(
    () => normalizeStateUpdate(1, { block_hash: HASH(1) }),
    (error) => error.code === "INVALID_STATE_UPDATE",
  );
  assert.throws(
    () => normalizeStateUpdate(1, { ...base, state_diff: { ...EMPTY_DIFF, deployed_contracts: "x" } }),
    (error) => error.code === "INVALID_STATE_UPDATE",
  );
  assert.throws(
    () =>
      normalizeStateUpdate(1, {
        ...base,
        state_diff: { ...EMPTY_DIFF, deployed_contracts: [{ address: C(1) }] },
      }),
    (error) => error.code === "INVALID_STATE_UPDATE",
  );
  assert.throws(
    () =>
      normalizeStateUpdate(1, {
        ...base,
        state_diff: { ...EMPTY_DIFF, replaced_classes: [{ contract_address: "0xzz", class_hash: CLASS(1) }] },
      }),
    (error) => error.code === "INVALID_STATE_UPDATE",
  );
  const ok = normalizeStateUpdate(1, {
    ...base,
    state_diff: {
      ...EMPTY_DIFF,
      deployed_contracts: [{ address: C(1), class_hash: CLASS(1) }],
      replaced_classes: [{ contract_address: C(2), class_hash: CLASS(2) }],
    },
  });
  assert.equal(ok.hash, HASH(1));
  assert.equal(ok.deployments.length, 1);
  assert.equal(ok.replacements.length, 1);
});

test("a journal hash conflict aborts the commit without partial writes", async () => {
  const store = new Store(":memory:");
  for (let n = 1; n <= 3; n++)
    store.applyBlock({
      number: n,
      hash: HASH(n),
      parentHash: HASH(n - 1),
      timestamp: 1000 + n,
      events: [],
      sources: [],
    });
  const rpc = harness({
    head: 4,
    stateHashes: { 2: "0xbad02" },
    stateUpdates: { 2: { deployed_contracts: [{ address: C(1), class_hash: CLASS(1) }] } },
  });
  await assert.rejects(
    discoverOnce(store, rpc, CONFIG, { span: 10 }),
    (error) => error.code === "CHAIN_CONFLICT",
  );
  assert.deepEqual(store.list("catalog_collection"), []);
  assert.equal(store.get("source_coverage", coverageId()), null);
  store.close();
});

test("emitter candidates come from unfiltered event pages within budget", async () => {
  const store = new Store(":memory:");
  const rpc = harness({
    head: 3,
    emitters: { 2: [C(7), C(8), C(9)] },
    stateUpdates: { 1: { deployed_contracts: [{ address: C(1), class_hash: CLASS(1) }] } },
  });
  const result = await discoverOnce(store, rpc, CONFIG, { span: 10, emitterBudget: 2 });
  assert.ok(result.emittersIncomplete, "budget exhaustion is reported, not silent");
  const candidate = store.get("catalog_collection", recordId(C(7)));
  assert.equal(candidate.state, "candidate");
  assert.equal(candidate.deployment, null);
  assert.deepEqual(candidate.classHistory, []);
  const known = store.get("catalog_collection", recordId(C(1)));
  assert.equal(known.state, "candidate", "emitters never downgrade known records");
  assert.ok(rpc.eventCalls >= 1);
  store.close();
});

test("discovery ranges stay bounded and idempotent by checkpoint", () => {
  assert.deepEqual(planDiscoveryRange({ earliest: 0, head: 10, span: 4 }), { from: 0, to: 3 });
  assert.equal(planDiscoveryRange({ checkpoint: 3, earliest: 0, head: 10, span: 4 }).from, 4);
  assert.equal(planDiscoveryRange({ checkpoint: 10, earliest: 0, head: 10, span: 4 }), null);
  assert.equal(planDiscoveryRange({ checkpoint: 3, earliest: 0, head: 10, span: 4, stopAt: 5 }).to, 5);
  assert.equal(planDiscoveryRange({ earliest: 20, head: 10, span: 4 }), null);
  for (const span of [0, -1, 1.5, 5001, "4"])
    assert.throws(
      () => planDiscoveryRange({ earliest: 0, head: 10, span }),
      (error) => error.code === "INVALID_WINDOW",
    );
});

test("unsupported state updates fail loudly instead of claiming coverage", async () => {
  const store = new Store(":memory:");
  const rpc = harness({ head: 5, eventsError: null });
  rpc.call = async (method, params) => {
    if (method === "starknet_chainId") return CHAIN_ID;
    if (method === "starknet_getBlockWithTxHashes") {
      const n = params.block_id === "latest" ? 5 : params.block_id.block_number;
      return {
        block_number: n,
        block_hash: HASH(n),
        parent_hash: HASH(n - 1),
        timestamp: 1000 + n,
        status: "ACCEPTED_ON_L2",
        transactions: [],
      };
    }
    if (method === "starknet_getStateUpdate") throw rpcError(-32601, "Method not found");
    throw new Error(`unexpected method ${method}`);
  };
  await assert.rejects(
    discoverOnce(store, rpc, CONFIG, { span: 10 }),
    (error) => error.code === "DISCOVERY_UNSUPPORTED",
  );
  assert.equal(store.get("source_coverage", coverageId()), null);
  store.close();
});
