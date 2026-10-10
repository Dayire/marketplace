import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Catalog } from "../src/catalog.mjs";
import { address } from "../src/domain.mjs";
import { collectionKey, collectionRecord, sourceCoverage } from "../src/collection-catalog.mjs";
import { metadataCandidates } from "../src/metadata-store.mjs";

const A = address("0xa1"), D = address("0xd1"), CHAIN = "0x1";
function fixture(t) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const config = { chain: "LOCAL", chainId: CHAIN, collections: [{ address: A, startBlock: 0 }], currencies: [] };
  for (const collection of [A, D]) {
    store.put("collection", collection, { address: collection, name: collection === A ? "Configured" : "Discovered" });
    store.put("token", `${collection}:9007199254740993`, {
      id: `${collection}:9007199254740993`, collection, tokenId: "9007199254740993", owner: address("2"),
      metadata: { name: "Discovered token" }, attributes: [],
    });
    store.put("activity", `${collection}:event`, { collection, type: "transfer", from: address("0"), to: address("2"), provenance: { blockNumber: 1 } });
  }
  store.put("catalog_collection", collectionKey(CHAIN, D), collectionRecord({
    chainId: CHAIN, address: D, state: "indexed", standard: "ERC721", deployment: { block: 0, hash: "0x1" },
  }));
  const visible = (a, value) => store.app.prepare("INSERT INTO app_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(`catalog_visibility:${collectionKey(CHAIN, a)}`, JSON.stringify({ visible: value }));
  return { store, config, catalog: new Catalog(store, config), visible };
}

test("discovered collections stay private until an independent visibility override", (t) => {
  const { catalog, visible } = fixture(t);
  assert.throws(() => catalog.tokens(D), { code: "CONTENT_RESTRICTED" });
  assert.deepEqual(catalog.collections().map((c) => c.address), [A]);
  assert.deepEqual(catalog.holdings("2").items.map((item) => item.collection), [A]);
  assert.equal(catalog.search("d1").discoveredCollections.length, 0);
  assert.equal(catalog.activity({ account: "2" }).items.length, 1);
  visible(D, true);
  const exposed = catalog.collection(D);
  assert.equal(exposed.verified, false, "visibility does not grant verification");
  assert.equal(catalog.tokens(D).items[0].tokenId, "9007199254740993");
  assert.equal(catalog.search("d1").discoveredCollections.length, 1);
  assert.equal(catalog.activity({ account: "2" }).items.length, 2);
});

test("explicit visibility false and moderation win over configured defaults", (t) => {
  const { store, catalog, visible } = fixture(t);
  visible(A, false);
  assert.throws(() => catalog.collection(A), { code: "CONTENT_RESTRICTED" });
  assert.equal(catalog.tokens(null).items.length, 0);
  visible(D, true);
  store.app.prepare("INSERT INTO moderation VALUES(?,?)").run(D, "{}");
  assert.equal(catalog.holdings("2").items.length, 0);
  assert.equal(catalog.search("d1").discoveredCollections.length, 0);
});

test("public discovery freshness reports partial, failed and stale-generation coverage", (t) => {
  const { store, catalog, visible } = fixture(t);
  visible(D, true);
  const now = Date.now();
  store.db.prepare("INSERT INTO blocks VALUES(?,?,?,?)").run(12, "0xabc", "0x1", 1);
  store.put("status", "rpc", { head: 12, observedAt: now, identityVerified: true });
  const key = collectionKey(CHAIN, D);
  const coverage = sourceCoverage({ chainId: CHAIN, address: D, mode: "catalog", startBlock: 0,
    block: 12, hash: "0xabc", observedAt: now, replayGeneration: 1, gaps: [{ from: 2, to: 3, reason: "RPC unavailable" }] });
  store.put("source_coverage", key, coverage);
  const partial = catalog.collection(D);
  assert.deepEqual(partial.coverage, coverage);
  assert.equal(partial.source.ready, false);
  assert.ok(partial.source.reasons.includes("HISTORY_GAP"));
  store.put("catalog_collection", key, { ...store.get("catalog_collection", key), state: "failed" });
  assert.ok(catalog.collection(D).source.reasons.includes("SOURCE_FAILED"));
  store.put("source_coverage", key, { ...coverage, gaps: [], replayGeneration: 2 });
  assert.ok(catalog.collection(D).source.reasons.includes("GENERATION_MISMATCH"));
  const page = catalog.holdings("2", { limit: 1 });
  assert.equal(page.basis, "indexed");
  assert.equal(page.generation, 1);
});

test("class upgrades suppress obsolete owner/balance shapes and keep incomplete source evidence in holdings", async (t) => {
  const { store, catalog, visible } = fixture(t); visible(D, true);
  const id = "9007199254740993", owner = address("2"), key = `${D}:${id}:${owner}`;
  store.put("erc1155_balance", key, { collection: D, tokenId: id, owner, balance: "7", balanceFelts: ["0x7", "0x0"] });
  assert.equal(catalog.balances(owner).items.length, 0, "ERC721 classification suppresses obsolete balance rows");
  const catalogKey = collectionKey(CHAIN, D);
  store.put("catalog_collection", catalogKey, { ...store.get("catalog_collection", catalogKey), standard: "ERC1155", state: "failed" });
  assert.equal(catalog.tokens(D).items.length, 0, "ERC1155 cannot reuse an old single-owner row");
  assert.throws(() => catalog.token(D, id), { code: "NOT_FOUND" });
  const page = catalog.balances(owner);
  assert.equal(page.items[0].balance, "7");
  assert.equal(page.sources[0].source.ready, false);
  assert.ok(page.sources[0].source.reasons.includes("SOURCE_FAILED"));
  const candidate = (await metadataCandidates(store, Date.now(), 10, 5)).find((item) => item.collection === D);
  assert.equal(candidate.standard, "ERC1155");
  assert.equal(candidate.metadataSourceId, key);
  assert.equal(catalog.activity({ account: owner }).items.length, 2, "historical evidence is retained");
  store.put("catalog_collection", catalogKey, { ...store.get("catalog_collection", catalogKey), standard: null, state: "unknown" });
  const unclassified = catalog.tokens(D);
  assert.equal(unclassified.sourceScope, "page");
  assert.equal(unclassified.sources[0].source.ready, false);
  assert.ok(unclassified.sources[0].source.reasons.includes("SOURCE_UNCLASSIFIED"));
});
