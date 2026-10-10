import { test } from "node:test";
import assert from "node:assert/strict";
import { createMarketplaceClient } from "../dist/index.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("additive balances read keeps ERC1155 quantities, cursor, coverage and cached assets lossless", async () => {
  const max = (2n ** 256n - 1n).toString(), requests = [];
  const client = createMarketplaceClient({ apiUrl: "https://indexer.example", chain: "LOCAL", chainId: "0x1",
    fetch: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ data: { items: [{ id: `0xa:${max}:0x2`, collection: "0xa", tokenId: max,
        owner: "0x2", standard: "ERC1155", balance: max, balanceFelts: ["0xffffffffffffffffffffffffffffffff", "0xffffffffffffffffffffffffffffffff"],
        metadata: {}, attributes: [], image: "/api/marketplace/v1/chains/LOCAL/assets/test.png" }],
        nextCursor: "opaque", basis: "indexed", generation: 7, standard: "ERC1155", sourceScope: "page",
        sources: [{ collection: "0xa", source: { ready: false, reasons: ["SOURCE_FAILED"], generation: 7,
          chainHead: 12, observedAt: 1000 } }] }, meta: { schemaVersion: "1.0.0", chain: "LOCAL", generation: 7 } }));
    } });
  try {
    const page = await client.accounts.balances("0x2", { collection: "0xa", limit: 1 });
    assert.equal(page.items[0].tokenId, max);
    assert.equal(page.items[0].balance, max);
    assert.equal(page.items[0].image, "https://indexer.example/v1/chains/LOCAL/assets/test.png");
    assert.equal(page.basis, "indexed");
    assert.equal(page.generation, 7);
    assert.equal(page.nextCursor, "opaque");
    assert.equal(page.sourceScope, "page");
    assert.equal(page.sources[0].source.ready, false);
    assert.deepEqual(page.sources[0].source.reasons, ["SOURCE_FAILED"]);
    assert.match(requests[0], /\/accounts\/0x2\/balances\?/);
    assert.match(requests[0], /collection=0xa/);
  } finally { client.dispose(); }
});

test("collection and search reads preserve partial discovery and reconciliation evidence", async () => {
  const collection = { address: "0xa", name: "Discovered", tokenCount: "0", listingCount: "0", floorByCurrency: [],
    verified: false, basis: "indexed", generation: 7,
    chain: { state: "failed", standard: "ERC721", method: "abi", uncertainty: "abi_only", decoderVersion: "nft-events.v2", replayGeneration: 7 },
    coverage: { startBlock: 1, block: 12, hash: "0xabc", observedAt: 1000, replayGeneration: 7, gaps: [{ from: 2, to: 3, reason: "RPC unavailable" }] },
    source: { ready: false, reasons: ["SOURCE_FAILED", "HISTORY_GAP"], generation: 7, chainHead: 12, observedAt: 1000 },
    reconciliation: { state: "partial", ok: true, confidence: "partial", checked: 1, projectedCount: "9007199254740993",
      mismatches: [], errors: [], limitations: ["No total-supply inventory proof"], block: 12, hash: "0xabc", replayGeneration: 7, observedAt: 1000 } };
  const client = createMarketplaceClient({ apiUrl: "https://indexer.example", chain: "LOCAL", chainId: "0x1",
    fetch: async (url) => new Response(JSON.stringify({ data: String(url).includes("/search?")
      ? { collections: [collection], tokens: [], discoveredCollections: [{ ...collection, basis: "chain" }] } : collection })) });
  try {
    const value = await client.collections.get("0xa");
    assert.deepEqual(value.source.reasons, ["SOURCE_FAILED", "HISTORY_GAP"]);
    assert.equal(value.reconciliation.projectedCount, "9007199254740993");
    const search = await client.search("Discovered");
    assert.equal(search.discoveredCollections[0].basis, "chain");
    assert.equal(search.collections[0].verified, false);
  } finally { client.dispose(); }
});

test("public declarations keep legacy ERC721 consumers and expose lossless discovery/balance types", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.resolve("typescript/lib/tsc.js")),
    "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022",
    fileURLToPath(new URL("./type-contract/discovery.ts", import.meta.url))], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
