import { test } from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./helpers.mjs";
import { migrate } from "../../src/postgres/migrate.mjs";
import { PgStore } from "../../src/postgres/store.mjs";
import { PgCatalog } from "../../src/postgres/catalog.mjs";
import { PgDiscoveryCatalog } from "../../src/postgres/discovery-catalog.mjs";
import { createApi } from "../../src/api.mjs";
import { address, MAX_U256 } from "../../src/domain.mjs";
import { collectionRecord, collectionKey, sourceCoverage } from "../../src/collection-catalog.mjs";
import { metadataCandidates } from "../../src/metadata-store.mjs";

const A = address("0xa1"), D = address("0xd1"), CHAIN = "0x1";
async function fixture(t) {
  const db = await testDatabase(t), pool = db.pool();
  await migrate(pool);
  const store = new PgStore(pool), config = { chain: "LOCAL", chainId: CHAIN,
    collections: [{ address: A, startBlock: 0 }], currencies: [], operatorToken: "a".repeat(32) };
  for (const collection of [A, D]) {
    await store.put("collection", collection, { address: collection, name: collection === A ? "Configured" : "Discovered" });
    await store.put("token", `${collection}:9007199254740993`, {
      id: `${collection}:9007199254740993`, collection, tokenId: "9007199254740993", owner: address("2"),
    });
    await store.putMetadata(`${collection}:9007199254740993`, { metadata: { name: "Discovered token" }, attributes: [] });
    await store.put("activity", `${collection}:event`, { collection, type: "transfer", from: address("0"), to: address("2"),
      provenance: { blockNumber: 1, transactionHash: "0x1", timestamp: 1 } });
  }
  await store.put("catalog_collection", collectionKey(CHAIN, D), collectionRecord({
    chainId: CHAIN, address: D, state: "indexed", standard: "ERC721", deployment: { block: 0, hash: "0x1" },
  }));
  const visible = (a, value) => pool.query("INSERT INTO app.app_meta VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [`catalog_visibility:${collectionKey(CHAIN, a)}`, { visible: value }]);
  return { store, config, pool, catalog: new PgCatalog(store, config), visible };
}

test("PostgreSQL public catalog obeys independent discovery visibility across every read scope", async (t) => {
  const { store, config, catalog, visible, pool } = await fixture(t);
  await assert.rejects(catalog.tokens(D), { code: "CONTENT_RESTRICTED" });
  assert.deepEqual((await catalog.collections()).map((c) => c.address), [A]);
  assert.deepEqual((await catalog.holdings("2")).items.map((item) => item.collection), [A]);
  assert.equal((await catalog.search("d1")).discoveredCollections.length, 0);
  assert.equal((await catalog.activity({ account: "2" })).items.length, 1);
  assert.equal((await new PgDiscoveryCatalog(store, config).collection(D)).visible, false);
  await visible(D, true);
  assert.equal((await catalog.collection(D)).verified, false);
  assert.equal((await catalog.tokens(D)).items[0].tokenId, "9007199254740993");
  assert.equal((await catalog.search("d1")).discoveredCollections.length, 1);
  await visible(A, false);
  assert.equal((await catalog.holdings("2")).items.length, 1);
  await pool.query("INSERT INTO app.moderation VALUES($1,$2)", [D, {}]);
  assert.equal((await catalog.holdings("2")).items.length, 0);
  assert.equal((await catalog.search("d1")).discoveredCollections.length, 0);
});

test("PostgreSQL collection freshness exposes partial/failing coverage, reconciliation confidence and read generation", async (t) => {
  const { store, pool, catalog, visible } = await fixture(t);
  await visible(D, true);
  const now = Date.now(), key = collectionKey(CHAIN, D);
  await pool.query("INSERT INTO chain.blocks VALUES($1,$2,$3,$4)", [12, "0xabc", "0x1", 1]);
  await store.put("status", "rpc", { head: 12, observedAt: now, identityVerified: true });
  const coverage = sourceCoverage({ chainId: CHAIN, address: D, mode: "catalog", startBlock: 0,
    block: 12, hash: "0xabc", observedAt: now, gaps: [{ from: 2, to: 3, reason: "RPC unavailable" }] });
  await store.put("source_coverage", key, coverage);
  await store.put("status", `reconciliation:${D}`, { state: "partial", ok: true, confidence: "partial", replayGeneration: 1,
    checked: 1, projectedCount: "9007199254740993", limitations: ["No total-supply inventory proof"], block: 12, hash: "0xabc", observedAt: now });
  const partial = await catalog.collection(D);
  assert.deepEqual(partial.coverage, coverage);
  assert.equal(partial.source.ready, false);
  assert.ok(partial.source.reasons.includes("HISTORY_GAP"));
  assert.equal(partial.reconciliation.confidence, "partial");
  assert.equal(partial.reconciliation.projectedCount, "9007199254740993");
  await store.put("catalog_collection", key, { ...await store.get("catalog_collection", key), state: "failed" });
  assert.ok((await catalog.collection(D)).source.reasons.includes("SOURCE_FAILED"));
  await store.put("source_coverage", key, { ...coverage, replayGeneration: 2, gaps: [] });
  assert.ok((await catalog.collection(D)).source.reasons.includes("GENERATION_MISMATCH"));
  const page = await catalog.holdings("2", { limit: 1 });
  assert.equal(page.basis, "indexed");
  assert.equal(page.generation, 1);
  await pool.query("UPDATE chain.meta SET value='2'::jsonb WHERE key='generation'");
  await assert.rejects(catalog.holdings("2", { limit: 1, cursor: page.nextCursor }), { code: "CURSOR_MISMATCH" });
  assert.equal((await catalog.collection(D)).reconciliation, null);
});

test("ERC1155 balances are an additive positive, owner-scoped, lossless endpoint", async (t) => {
  const { store, config, catalog, visible } = await fixture(t);
  await visible(D, true);
  await store.put("catalog_collection", collectionKey(CHAIN, D), {
    ...await store.get("catalog_collection", collectionKey(CHAIN, D)), standard: "ERC1155",
  });
  for (const [tokenId, owner, balance] of [["2", "2", "0"], ["10", "2", "7"], [MAX_U256.toString(), "2", MAX_U256.toString()], ["3", "3", "8"]]) {
    const body = { collection: D, tokenId, owner: address(owner), balance,
      balanceFelts: ["0x" + (BigInt(balance) & ((1n << 128n) - 1n)).toString(16), "0x" + (BigInt(balance) >> 128n).toString(16)] };
    await store.put("erc1155_balance", `${D}:${tokenId}:${body.owner}`, body);
  }
  const page = await catalog.balances("2", { limit: 1 });
  assert.equal(page.items[0].tokenId, "10");
  assert.equal(page.items[0].balance, "7");
  assert.equal(page.items[0].standard, "ERC1155");
  assert.equal(page.standard, "ERC1155");
  assert.equal(page.basis, "indexed");
  const next = await catalog.balances("2", { limit: 1, cursor: page.nextCursor });
  assert.equal(next.items[0].tokenId, MAX_U256.toString());
  assert.equal(next.items[0].balance, MAX_U256.toString());
  await assert.rejects(catalog.balances("3", { cursor: page.nextCursor }), { code: "CURSOR_MISMATCH" });
  await assert.rejects(catalog.balances("3", { owner: address("2"), cursor: page.nextCursor }), { code: "CURSOR_MISMATCH" });
  assert.equal((await catalog.holdings("2")).items[0].owner, address("2"));
  const api = createApi({ store, config });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  t.after(() => { api.closeAllConnections(); api.close(); });
  const root = `http://127.0.0.1:${api.address().port}/v1/chains/LOCAL`;
  const response = await fetch(`${root}/accounts/2/balances?limit=1`).then((r) => r.json());
  assert.equal(response.data.items[0].balance, "7");
  assert.equal(response.meta.generation, 1);
  await visible(D, false);
  assert.equal((await catalog.balances("2")).items.length, 0);
});

test("operator publishes a known catalog-only source without granting verification or settlement policy", async (t) => {
  const { store, config, pool } = await fixture(t);
  await pool.query("DELETE FROM market.collections WHERE id=$1", [D]);
  const api = createApi({ store, config });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  t.after(() => { api.closeAllConnections(); api.close(); });
  const root = `http://127.0.0.1:${api.address().port}/v1/chains/LOCAL`;
  const publish = (data, authorized = true) => fetch(`${root}/operator/collections`, { method: "POST",
    headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${config.operatorToken}` } : {}) },
    body: JSON.stringify(data) });
  assert.equal((await publish({ address: D, visible: true }, false)).status, 403);
  assert.equal((await publish({ address: D, visible: "false" })).status, 400);
  const response = await publish({ address: D, visible: true });
  assert.equal(response.status, 200);
  const exposed = await fetch(`${root}/collections/${D}`).then((r) => r.json());
  assert.equal(exposed.data.address, D);
  assert.equal(exposed.data.verified, false);
  assert.equal(await store.get("collection", D), null);
  assert.equal(await store.get("policy", `collection:${D}`), null);
  assert.equal(config.collections.some((c) => c.address === D), false);
  assert.equal((await publish({ address: address("0xee"), visible: true })).status, 409);
  assert.equal((await publish({ address: D, visible: false })).status, 200);
  assert.equal((await fetch(`${root}/collections/${D}`)).status, 404);
});

test("PostgreSQL class upgrades exclude obsolete current ownership shapes without deleting historical activity", async (t) => {
  const { store, catalog, visible } = await fixture(t); await visible(D, true);
  const id = "9007199254740993", owner = address("2"), key = `${D}:${id}:${owner}`;
  await store.put("erc1155_balance", key, { collection: D, tokenId: id, owner, balance: "7", balanceFelts: ["0x7", "0x0"] });
  assert.equal((await catalog.balances(owner)).items.length, 0);
  const catalogKey = collectionKey(CHAIN, D);
  await store.put("catalog_collection", catalogKey, { ...await store.get("catalog_collection", catalogKey), standard: "ERC1155", state: "failed" });
  assert.equal((await catalog.tokens(D)).items.length, 0);
  await assert.rejects(catalog.token(D, id), { code: "NOT_FOUND" });
  const page = await catalog.balances(owner);
  assert.equal(page.items[0].balance, "7");
  assert.equal(page.sources[0].source.ready, false);
  assert.ok(page.sources[0].source.reasons.includes("SOURCE_FAILED"));
  const candidate = (await metadataCandidates(store, Date.now(), 10, 5)).find((item) => item.collection === D);
  assert.equal(candidate.standard, "ERC1155");
  assert.equal(candidate.metadataSourceId, key);
  assert.equal((await catalog.activity({ account: owner })).items.length, 2);
  await store.put("catalog_collection", catalogKey, { ...await store.get("catalog_collection", catalogKey), standard: null, state: "unknown" });
  const unclassified = await catalog.tokens(D);
  assert.equal(unclassified.sourceScope, "page");
  assert.equal(unclassified.sources[0].source.ready, false);
  assert.ok(unclassified.sources[0].source.reasons.includes("SOURCE_UNCLASSIFIED"));
});
