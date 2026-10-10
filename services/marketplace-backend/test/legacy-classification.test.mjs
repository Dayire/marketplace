import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "../src/store.mjs";
import { resolveClassEvidence, classifyOnce } from "../src/classify-scan.mjs";
import { summarizeAbi, ABI_SUMMARY_VERSION, INTROSPECTION, needsClassification } from "../src/classify.mjs";
import { selectorFromName } from "../src/starknet-selector.mjs";
import { collectionRecord, sourceCoverage } from "../src/collection-catalog.mjs";
import { discoveryKey, DISCOVERY_ADDRESS } from "../src/discovery.mjs";
import { address } from "../src/domain.mjs";

const f = JSON.parse(readFileSync(new URL("./fixtures/legacy-mainnet.json", import.meta.url), "utf8"));
const c = (name) => f.classes.find((item) => item.name === name);
const pin = f.receipts.find((item) => item.name === "briq-mint");
const briq = address(pin.receipt.events[0].from_address);

function rpcFixture({ sourceClass = c("briq-proxy"), implementation = c("briq-initial-implementation"), slot = implementation.classHash } = {}) {
  const calls = [];
  return { calls, async call(method, params) {
    calls.push({ method, params });
    assert.deepEqual(params.block_id, { block_hash: pin.blockHash }, "every address-specific read stays on the exact hash");
    if (method === "starknet_getClassHashAt") {
      if (address(params.contract_address) !== briq) throw new Error("Class is not an address");
      return sourceClass.classHash;
    }
    if (method === "starknet_getClass") {
      if (BigInt(params.class_hash) === BigInt(sourceClass.classHash)) return { abi: sourceClass.abi };
      if (BigInt(params.class_hash) === BigInt(implementation.classHash)) return { abi: implementation.abi };
      throw new Error("Unknown class");
    }
    if (method === "starknet_getStorageAt") {
      assert.equal(BigInt(params.key), BigInt(selectorFromName("Proxy_implementation_hash")));
      return slot;
    }
    if (method === "starknet_call") {
      assert.equal(params.request.entry_point_selector, selectorFromName("supportsInterface"));
      return [BigInt(params.request.calldata[0]) === BigInt(INTROSPECTION.interfaces.erc721Legacy) ? "0x1" : "0x0"];
    }
    throw new Error(`Unexpected ${method}`);
  }};
}

test("known deployed Cairo 0 proxy resolves immutable implementation ABI at the pinned hash", async (t) => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const rpc = rpcFixture();
  const evidence = await resolveClassEvidence(rpc, store, { classHash: c("briq-proxy").classHash, contractAddress: briq, blockId: { block_hash: pin.blockHash } });
  assert.equal(evidence.summary.classHash, c("briq-proxy").classHash);
  assert.equal(evidence.effectiveSummary.classHash, c("briq-initial-implementation").classHash);
  assert.equal(evidence.implementation.classHash, c("briq-initial-implementation").classHash);
  assert.equal(evidence.proxyUncertainty, "proxy_verified");
  assert.equal(evidence.proxyEvidence[0].adapter, "oz-cairo0-implementation-slot.v1");
  assert.deepEqual(evidence.proxyEvidence[0].blockId, { block_hash: pin.blockHash });
  assert.equal(rpc.calls.filter((item) => item.method === "starknet_getStorageAt").length, 1);
});

test("an arbitrary __default__ contract never inherits the known OZ proxy slot adapter", async (t) => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const sourceClass = { ...c("briq-proxy"), classHash: "0x88888" };
  const rpc = rpcFixture({ sourceClass });
  const evidence = await resolveClassEvidence(rpc, store, { classHash: sourceClass.classHash, contractAddress: briq, blockId: { block_hash: pin.blockHash } });
  assert.equal(evidence.proxyUncertainty, "proxy_unverified");
  assert.equal(evidence.implementation, null);
  assert.equal(rpc.calls.filter((item) => item.method === "starknet_getStorageAt").length, 0);
});

test("empty or unavailable implementation slot preserves an actionable unsupported reason", async (t) => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const evidence = await resolveClassEvidence(rpcFixture({ slot: "0x0" }), store, { classHash: c("briq-proxy").classHash, contractAddress: briq, blockId: { block_hash: pin.blockHash } });
  assert.equal(evidence.proxyUncertainty, "proxy_unverified");
  assert.equal(evidence.implementation, null);
  assert.equal(evidence.proxyEvidence[0].reason, "empty_implementation_slot");
});

test("read-only evidence users can fetch without writing the cache; obsolete summaries refresh", async () => {
  const rpc = rpcFixture();
  const stale = { classHash: c("briq-proxy").classHash, functions: ["__default__"], events: [] };
  const store = { get: async () => stale, put: async () => assert.fail("read-only role must not write class evidence") };
  const evidence = await resolveClassEvidence(rpc, store, { classHash: c("briq-proxy").classHash, contractAddress: briq, blockId: { block_hash: pin.blockHash }, cacheWrite: false });
  assert.equal(evidence.summary.abiSummaryVersion, ABI_SUMMARY_VERSION);
  assert.ok(evidence.effectiveSummary.functions.includes("ownerOf"));
});

test("real legacy proxy classification stores alias, block-hash and implementation evidence", async (t) => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const record = collectionRecord({ chainId: f.chainId, address: briq, state: "candidate", standard: null, classHistory: [{ classHash: c("briq-proxy").classHash, from: { block: 10423, hash: f.receipts.find((r) => r.name === "briq-deployment").blockHash, transactionIndex: 28, eventIndex: 1 }, to: null }] });
  store.put("catalog_collection", record.id, record);
  const coverage = sourceCoverage({ chainId: f.chainId, address: DISCOVERY_ADDRESS, sourceType: "discovery", mode: "catalog", startBlock: 0, block: pin.blockNumber, hash: pin.blockHash, observedAt: Date.now(), replayGeneration: 1, gaps: [] });
  store.put("source_coverage", discoveryKey(f.chainId), coverage);
  store.put("discovery_anchor", String(pin.blockNumber), { block: pin.blockNumber, hash: pin.blockHash });
  const outcome = await classifyOnce(store, rpcFixture(), { chain: "SN_MAIN", chainId: f.chainId, collections: [] });
  assert.equal(outcome.classified, 1);
  const classified = store.get("catalog_collection", record.id);
  assert.equal(classified.standard, "ERC721");
  assert.equal(classified.classification.uncertainty, "proxy_verified");
  assert.equal(classified.classification.implementationClassHash, c("briq-initial-implementation").classHash);
  assert.equal(classified.classification.evidenceBlockHash, pin.blockHash);
  assert.deepEqual(classified.classification.aliases.owner_of, ["ownerOf"]);
  assert.ok(classified.classification.evidence.some((item) => item.kind === "proxy_implementation"));
  assert.equal(needsClassification(classified, pin.blockNumber + 1), true, "unchanged proxy class cannot imply unchanged implementation at another block");
});
