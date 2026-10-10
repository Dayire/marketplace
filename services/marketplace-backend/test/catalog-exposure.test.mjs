import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Catalog } from "../src/catalog.mjs";
import { collectionKey, collectionRecord } from "../src/collection-catalog.mjs";
import { classificationPatch } from "../src/classify.mjs";
import { metadataCandidates } from "../src/metadata-store.mjs";
import { refreshMetadata } from "../src/metadata.mjs";
import { address } from "../src/domain.mjs";

const CHAIN = "0x1";
const A = address("0xa1");
const D = address("0xd1");
const OTHER = address("0xb1");

function catalogFixture() {
  const store = new Store(":memory:");
  const config = { chain: "LOCAL", chainId: CHAIN, currencies: [] };
  store.put("collection", A, { name: "Demo", address: A });
  store.put("progress", A, {
    chainId: CHAIN,
    address: A,
    startBlock: 0,
    block: 12,
    hash: "0xabc",
    observedAt: 111,
  });
  const discovered = collectionRecord(
    {
      chainId: CHAIN,
      address: D,
      state: "candidate",
      standard: "ERC721",
      deployment: { block: 1, tx: "0x99", hash: "0xaaa" },
    },
    {},
  );
  const patched = collectionRecord(
    discovered,
    classificationPatch(discovered, {
      standard: "ERC721",
      classification: {
        method: "erc165",
        uncertainty: "identifier lookup absent; classified from ABI shape",
        evidence: { interfaceIds: ["0x80ac58cd"] },
      },
    }),
  );
  store.put("catalog_collection", patched.id, patched);
  return { store, config, catalog: new Catalog(store, config) };
}

test("collections expose coverage and chain state beside existing fields", () => {
  const { store, catalog } = catalogFixture();
  const demo = catalog.collection(A);
  // Compatibility: every legacy field stays intact.
  assert.equal(demo.name, "Demo");
  assert.equal(demo.address, A);
  assert.equal(demo.verified, false);
  assert.equal(typeof demo.tokenCount, "string");
  assert.ok(Array.isArray(demo.floorByCurrency));
  // Additive: source freshness and discovery state.
  assert.deepEqual(demo.coverage, {
    startBlock: 0,
    block: 12,
    hash: "0xabc",
    observedAt: 111,
  });
  assert.equal(demo.chain, null, "product registry is not a chain record");

  store.put("collection", OTHER, { name: "Other", address: OTHER });
  const other = catalog.collection(OTHER);
  assert.equal(other.coverage, null, "no coverage reads as null, not absent");
  assert.equal(other.chain, null);
  const discovered = store.get(
    "catalog_collection",
    collectionKey(CHAIN, D),
  );
  assert.equal(discovered.standard, "ERC721");
  store.close();
});

test("tokens and search label indexed scope apart from chain scope", () => {
  const { store, catalog } = catalogFixture();
  store.put("token", `${A}:1`, {
    collection: A,
    tokenId: "1",
    owner: address("0xdead"),
    attributes: {},
    firstSeenBlock: 1,
  });
  const page = catalog.tokens(A, {});
  assert.equal(page.basis, "indexed", "holdings are explicitly indexed-scope");
  assert.ok(Array.isArray(page.items));
  assert.ok("nextCursor" in page, "pagination cursor contract unchanged");

  const results = catalog.search("demo");
  assert.equal(results.collections[0].name, "Demo");
  assert.ok(Array.isArray(results.tokens));
  assert.ok(Array.isArray(results.discoveredCollections), "scope key always present");
  const chainResults = catalog.search("d1");
  const discovered = chainResults.discoveredCollections;
  assert.equal(discovered.length, 1, "chain records exposed by address");
  assert.equal(discovered[0].address, D);
  assert.equal(discovered[0].basis, "chain", "chain scope is labeled");
  assert.equal(discovered[0].state, "candidate");
  assert.equal(discovered[0].standard, "ERC721");
  store.close();
});

test("metadata queue ranking keeps one collection from exhausting a pass", async () => {
  const { store } = catalogFixture();
  const now = Math.floor(Date.now() / 1000);
  const COLS = [A, OTHER];
  for (const col of COLS)
    for (let i = 0; i < 6; i++)
      store.put("token", `${col}:${i}`, {
        id: `${col}:${i}`,
        collection: col,
        tokenId: String(i),
        owner: address("0xdead"),
        metadataNextAttempt: 0,
      });

  const legacy = await metadataCandidates(store, now, 6);
  assert.equal(legacy.length, 6, "quota=null keeps legacy behavior");

  const limited = await metadataCandidates(store, now, 6, 3);
  assert.equal(limited.length, 6);
  const perCollection = new Map();
  for (const body of limited)
    perCollection.set(
      body.collection,
      (perCollection.get(body.collection) ?? 0) + 1,
    );
  for (const [col, count] of perCollection)
    assert.ok(count <= 3, `collection ${col} took ${count} of the pass`);

  const empty = await refreshMetadata(store, null, { currencies: [] }, {
    limit: 4,
  });
  assert.equal(empty.fetched ?? 0, 0, "refresh quota wiring is inert-clean");
  store.close();
});
