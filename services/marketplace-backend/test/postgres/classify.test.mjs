import { test } from "node:test";
import assert from "node:assert/strict";
import { PgStore } from "../../src/postgres/store.mjs";
import { migrate } from "../../src/postgres/migrate.mjs";
import { testDatabase } from "./helpers.mjs";
import { classifyOnce } from "../../src/classify-scan.mjs";
import { DISCOVERY_ADDRESS, discoveryKey } from "../../src/discovery.mjs";
import {
  collectionKey,
  collectionRecord,
  sourceCoverage,
} from "../../src/collection-catalog.mjs";
import { ApiError, address } from "../../src/domain.mjs";

const CHAIN_ID = "0x1";
const CONFIG = { chain: "LOCAL", chainId: CHAIN_ID, marketplace: null, collections: [] };
const CONTRACT = address("0x00000000000000000000000000000000000000000000000000000000000abc1");
const CLASS = "0x0def1";
const HASH = (n) => "0x" + (0x700000 + n).toString(16);
const BLOCK = 5;
const ERC721_INTERFACE = "0x33eb2f84c309543403fd69f0d0f363781ef06ef6faeb0131ff16ea3175bd943";
const SUPPORTS_SELECTOR = "0xfe80f537b66d12a00b6d3c072b44afbb716e78dde5c3f0ef116ee93d3e3283";

const rpcError = (code, message) =>
  new ApiError("RPC_CONTRACT_ERROR", message, 502, { rpcCode: code });

function harness() {
  return {
    call: async (method, params) => {
      if (method === "starknet_getClassHashAt") return CLASS;
      if (method === "starknet_getClass")
        return {
          abi: [
            { type: "function", name: "supports_interface", inputs: [] },
            { type: "function", name: "owner_of", inputs: [] },
            { type: "function", name: "transfer_from", inputs: [] },
            {
              type: "event",
              name: "ERC721Component::Transfer",
              kind: "struct",
              members: [
                { name: "from", kind: "key" },
                { name: "to", kind: "key" },
                { name: "token_id", kind: "key" },
              ],
            },
          ],
        };
      if (method === "starknet_call") {
        const id = params.request.calldata?.[0];
        if (params.request.entry_point_selector !== SUPPORTS_SELECTOR)
          throw rpcError(21, "Entry point not found");
        return [id === ERC721_INTERFACE ? "0x1" : "0x0"];
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

test("classification persists on PostgreSQL with class caching and rewindable evidence", async (t) => {
  const db = await testDatabase(t),
    pool = db.pool();
  await migrate(pool);
  const store = new PgStore(pool);

  await store.put(
    "catalog_collection",
    collectionKey(CHAIN_ID, CONTRACT),
    collectionRecord({
      chainId: CHAIN_ID,
      address: CONTRACT,
      state: "candidate",
      standard: null,
      deployment: { block: 2, hash: HASH(2), transactionIndex: null, eventIndex: null },
      classHistory: [
        {
          classHash: CLASS,
          from: { block: 2, hash: HASH(2), transactionIndex: null, eventIndex: null },
          to: null,
        },
      ],
      classification: null,
      decoderVersion: null,
      replayGeneration: 1,
    }),
    1,
  );
  await store.put(
    "source_coverage",
    discoveryKey(CHAIN_ID),
    sourceCoverage({
      chainId: CHAIN_ID,
      address: DISCOVERY_ADDRESS,
      sourceType: "discovery",
      mode: "catalog",
      startBlock: 0,
      block: BLOCK,
      hash: HASH(BLOCK),
      observedAt: Date.now(),
      replayGeneration: 1,
      gaps: [],
    }),
    BLOCK,
  );
  await store.put(
    "discovery_anchor",
    String(BLOCK),
    { block: BLOCK, hash: HASH(BLOCK) },
    BLOCK,
  );

  const result = await classifyOnce(store, harness(), CONFIG);
  assert.equal(result.classified, 1);
  const record = await store.get("catalog_collection", collectionKey(CHAIN_ID, CONTRACT));
  assert.equal(record.standard, "ERC721");
  assert.equal(record.state, "candidate");
  assert.equal(record.classification.method, "src5");
  const cached = await store.get("class_evidence", CLASS);
  assert.equal(cached.classHash, CLASS);

  // The classification rides at the checkpoint height: rewinding past it
  // removes the evidence, while the immutable class cache survives.
  await store.rewind(BLOCK - 1);
  const after = await store.get("catalog_collection", collectionKey(CHAIN_ID, CONTRACT));
  assert.equal(after.classification, null, "classification rewound with its block");
  assert.equal(after.state, "candidate");
  assert.ok(
    await store.get("class_evidence", CLASS),
    "class hash evidence is a rebuildable cache with no heights",
  );
  await store.close();
});
