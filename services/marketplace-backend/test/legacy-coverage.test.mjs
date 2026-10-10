import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "../src/store.mjs";
import { Catalog } from "../src/catalog.mjs";
import { createApi } from "../src/api.mjs";
import { scanOnce, recordQuarantine } from "../src/indexer.mjs";
import { collectionRecord, collectionKey } from "../src/collection-catalog.mjs";
import { classificationPatch } from "../src/classify.mjs";
import { decodeEvent } from "../src/decode.mjs";
import { SELECTORS } from "../src/decode.mjs";
import { address } from "../src/domain.mjs";
import { selectorFromName } from "../src/starknet-selector.mjs";

const CHAIN = "0x1";
const U = address("0x51"); // unsupported (fungible-like) contract
const Q = address("0x52"); // quarantined collection

test("coverage reports unsupported reasons, quarantines and missing coverage", async () => {
  const store = new Store(":memory:");
  const config = {
    chain: "LOCAL",
    chainId: CHAIN,
    currencies: [],
    collections: [{ address: address("0xaaa"), startBlock: 0 }],
  };

  const unsupportedSeed = collectionRecord(
    { chainId: CHAIN, address: U, state: "unknown", standard: null },
    {},
  );
  const unsupported = collectionRecord({
    ...unsupportedSeed,
    ...classificationPatch(unsupportedSeed, {
      standard: null,
      classification: {
        method: "erc165",
        uncertainty: "fungible ABI; no ERC721 or ERC1155 evidence",
        evidence: { reason: "fungible ABI; no ERC721 or ERC1155 evidence" },
      },
    }),
  });
  store.put("catalog_collection", unsupported.id, unsupported);

  await recordQuarantine(store, { chainId: CHAIN }, [
    {
      collection: Q,
      block: 7,
      transactionHash: "0x1",
      eventIndex: 0,
      code: "UNKNOWN_COLLECTION_EVENT",
      message: "selector not present in class ABI",
      selector: "0xdead",
    },
  ]);

  const report = new Catalog(store, config).coverage();
  assert.equal(report.counts.unsupported, 1);
  assert.equal(report.counts.failed, 1);
  assert.match(report.unsupported[0].reason, /fungible ABI/);
  assert.equal(report.unsupported[0].address, U);
  assert.equal(report.quarantined[0].quarantine.observations, 1);
  assert.equal(report.quarantined[0].quarantine.last.code, "UNKNOWN_COLLECTION_EVENT");
  assert.equal(report.notIndexed.length, 1, "registered but uncovered is visible");
  assert.equal(report.notIndexed[0].address, address("0xaaa"));

  store.put("progress", address("0xaaa"), {
    chainId: CHAIN,
    address: address("0xaaa"),
    startBlock: 0,
    block: 9,
    hash: "0x9",
    observedAt: 1,
  });
  assert.equal(
    new Catalog(store, config).coverage().notIndexed.length,
    0,
    "coverage clears once the source is indexed",
  );
  store.close();
});

test("the operator coverage route is gated and serves the report", async (t) => {
  const store = new Store(":memory:");
  const api = createApi({
    store,
    config: {
      chain: "LOCAL",
      chainId: CHAIN,
      marketplace: null,
      collections: [],
      currencies: [],
      origin: "http://localhost:3000",
      operatorToken: "op-secret",
    },
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  t.after(() => {
    api.closeAllConnections();
    api.close();
    store.close();
  });
  const root = `http://127.0.0.1:${api.address().port}`;
  let r = await fetch(root + "/v1/chains/LOCAL/operator/coverage");
  assert.equal(r.status, 403, "coverage reporting stays operator-only");
  r = await fetch(root + "/v1/chains/LOCAL/operator/coverage", {
    headers: { authorization: "Bearer op-secret" },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.data.counts, "report shape served");
  assert.deepEqual(body.data.unsupported, []);
});

function harness() {
  const hash = (n) => `0x${(100 + n).toString(16)}`;
  const X = address("0xa1");
  const event = {
    from_address: X,
    keys: [SELECTORS.Transfer],
    data: ["0x1", "0x2", "7", "0"],
    block_number: 1,
    block_hash: hash(1),
    transaction_hash: "0xf0",
  };
  return {
    X,
    call: async (method, p) => {
      if (method === "starknet_chainId") return "0x1";
      if (method === "starknet_getClassHashAt") return "0x0def1";
      if (method === "starknet_getClass") return { abi: [
        { type: "function", name: "owner_of", inputs: [{ name: "token_id", type: "Uint256" }], outputs: [{ name: "owner", type: "felt" }] },
        { type: "function", name: "transfer_from", inputs: [{ name: "from", type: "felt" }, { name: "to", type: "felt" }, { name: "token_id", type: "Uint256" }], outputs: [] },
        { type: "event", name: "Transfer", keys: [], data: [{ name: "from", type: "felt" }, { name: "to", type: "felt" }, { name: "token_id", type: "Uint256" }] },
      ] };
      if (method === "starknet_call") {
        assert.equal(p.request.entry_point_selector, selectorFromName("owner_of"));
        assert.deepEqual(p.block_id, { block_hash: hash(5) }, "reconciliation uses the source progress hash");
        assert.deepEqual(p.request.calldata, ["0x7", "0x0"]);
        return ["0x2"];
      }
      if (method === "starknet_getEvents") {
        const lo = p.filter.from_block.block_number,
          hi = p.filter.to_block.block_number;
        return { events: 1 >= lo && 1 <= hi ? [event] : [] };
      }
      const n = p.block_id === "latest" ? 5 : p.block_id.block_hash != null ? Number(BigInt(p.block_id.block_hash) - 100n) : Number(p.block_id.block_number);
      const block = {
        block_number: n,
        block_hash: hash(n),
        parent_hash: n === 0 ? "0x0" : hash(n - 1),
        timestamp: 100 + n,
        status: "ACCEPTED_ON_L2",
        transactions: [],
      };
      if (method === "starknet_getBlockWithReceipts" && n === 1)
        block.transactions = [
          {
            receipt: {
              transaction_hash: "0xf0",
              execution_status: "SUCCEEDED",
              events: [{ ...event, block_number: undefined }],
            },
          },
        ];
      return block;
    },
  };
}

test("replaying recorded blocks does not duplicate rows", async () => {
  const store = new Store(":memory:");
  const rpc = harness();
  const config = {
    chain: "LOCAL",
    chainId: CHAIN,
    marketplace: null,
    collections: [{ address: rpc.X, startBlock: 0 }],
  };
  const first = await scanOnce(store, rpc, config, { window: 10 });
  const count = (kind) => store.list(kind).length;
  const baseline = {
    tokens: count("token"),
    activity: count("activity"),
    blocks: count("block"),
    progress: count("progress"),
  };
  assert.ok(baseline.tokens >= 1, "fixture indexed");

  // Same range again through the overlay writer (duplicate delivery path).
  await scanOnce(store, rpc, config, {
    window: 10,
    scope: [rpc.X],
    from: 0,
    stopAt: first.indexed,
  });
  assert.deepEqual(
    {
      tokens: count("token"),
      activity: count("activity"),
      blocks: count("block"),
      progress: count("progress"),
    },
    baseline,
    "duplicate events never duplicate rows",
  );
  store.close();
});

test("recorded adapter fixtures replay identically without reinterpretation", () => {
  const config = JSON.parse(
    readFileSync(
      new URL("../../../config/marketplace/registry.realms.json", import.meta.url),
    ),
  ).chains.SN_MAIN;
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/realms-transfers.json", import.meta.url)),
  );
  const once = fixture.events.map((event) => decodeEvent(event, config));
  const twice = fixture.events.map((event) => decodeEvent(event, config));
  assert.deepEqual(twice, once, "decode is deterministic on recorded history");
  assert.deepEqual(
    once.map((token) => token.tokenId),
    ["1038", "1830", "1101"],
    "recorded expectations are unchanged",
  );
  assert.equal(collectionKey(CHAIN, Q), collectionKey(CHAIN, Q));
});
