import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Catalog } from "../src/catalog.mjs";
import { refreshMetadata } from "../src/metadata.mjs";
import { address, MAX_U256, u256Felts } from "../src/domain.mjs";
import { collectionRecord } from "../src/collection-catalog.mjs";
import { DECODER_CAPABILITY } from "../src/decode.mjs";
import { selectorFromName } from "../src/starknet-selector.mjs";

const A = address("0xa1"), OWNER = address("2"), CLASS = "0x123", HASH = "0x11";
const config = { chain: "LOCAL", chainId: "0x1", collections: [], currencies: [] };
const uriAbi = (name, type = "core::integer::u256") => ({ type: "function", name,
  inputs: [{ name: "token_id", type }], outputs: [{ type: "core::byte_array::ByteArray" }] });
const uriFelts = (uri) => {
  const bytes = Buffer.from(uri), words = []; let i = 0;
  for (; i + 31 <= bytes.length; i += 31) words.push("0x" + bytes.subarray(i, i + 31).toString("hex"));
  const rest = bytes.subarray(i);
  return [String(words.length), ...words, rest.length ? "0x" + rest.toString("hex") : "0", String(rest.length)];
};
function fixture(t, standard = "ERC1155", tokenId = MAX_U256.toString()) {
  const store = new Store(":memory:"); t.after(() => store.close());
  store.applyBlock({ number: 1, hash: HASH, parentHash: "0x0", timestamp: 1, events: [{
    type: standard === "ERC1155" ? "erc1155_transfer" : "transfer", collection: A, tokenId,
    value: "7", from: address("0"), to: OWNER, transactionHash: "0x22", eventIndex: 0,
  }] });
  const record = collectionRecord({ chainId: "0x1", address: A, state: "indexed", standard,
    decoderVersion: DECODER_CAPABILITY, deployment: { block: 1, hash: HASH },
    classHistory: [{ classHash: CLASS, from: { block: 1, hash: HASH }, to: null, decoderVersion: DECODER_CAPABILITY }],
    classification: { standard, method: "abi", classHash: CLASS, evidenceBlock: 1, uncertainty: "abi_only",
      aliases: standard === "ERC1155" ? { uri: ["URI"] } : { token_uri: ["tokenURI"] } },
  });
  store.put("catalog_collection", record.id, record);
  return { store, record };
}
const rpcFor = (abi, uri, calls) => ({
  call: async (method, params) => {
    assert.deepEqual(params.block_id, { block_hash: HASH });
    if (method === "starknet_getClassHashAt") return CLASS;
    if (method === "starknet_getClass") return { abi: JSON.stringify(abi) };
    throw new Error(`Unexpected RPC ${method}`);
  },
  contract: async (collection, selector, calldata, blockId) => {
    assert.ok(calldata.every((felt) => /^0x[0-9a-f]+$/.test(felt)), "RPC felt calldata must use hexadecimal strings");
    calls.push({ collection, selector, calldata, blockId });
    return uriFelts(uri);
  },
});

test("hidden discovered ERC1155 metadata uses the pinned declared URI alias and hexadecimal ID substitution", async (t) => {
  const { store } = fixture(t), calls = [], uris = [];
  const rpc = rpcFor([{ type: "interface", items: [uriAbi("URI")] }], "https://example.org/{id}.json", calls);
  await refreshMetadata(store, rpc, config, { limit: 1, fetchResource: async (uri) => {
    uris.push(uri); return { bytes: Buffer.from('{"name":"Multi token"}'), contentType: "application/json" };
  } });
  const key = `${A}:${MAX_U256}`;
  assert.equal(store.get("token_metadata", key)?.metadataStatus, "ready");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].selector, selectorFromName("URI"));
  assert.deepEqual(calls[0].calldata, u256Felts(MAX_U256).map((n) => "0x" + BigInt(n).toString(16)));
  assert.deepEqual(calls[0].blockId, { block_hash: HASH });
  assert.deepEqual(uris, [`https://example.org/${MAX_U256.toString(16).padStart(64, "0")}.json`]);
  assert.equal(store.get("token", key), null, "metadata never synthesizes a single owner");
  assert.equal(store.get("erc1155_balance", `${key}:${OWNER}`).balance, "7");
  assert.equal(new Catalog(store, config).balances(OWNER).items.length, 0, "indexing metadata does not publish content");
});

test("discovered ERC721 metadata calls the declared camel-case alias without granting trading permission", async (t) => {
  const { store } = fixture(t, "ERC721"), calls = [];
  await refreshMetadata(store, rpcFor([uriAbi("tokenURI")], "data:application/json,%7B%22name%22%3A%22Single%22%7D", calls), config, { limit: 1 });
  assert.equal(store.get("token", `${A}:${MAX_U256}`).metadataStatus, "ready");
  assert.equal(calls[0].selector, selectorFromName("tokenURI"));
  assert.equal(store.get("policy", `collection:${A}`), null);
});

test("unproven URI alias fails metadata with backoff and leaves ownership untouched", async (t) => {
  const { store } = fixture(t), calls = [];
  await refreshMetadata(store, rpcFor([{ type: "function", name: "name" }], "https://example.org/1.json", calls), config, {
    limit: 1, fetchResource: async () => { throw new Error("URI method proof should prevent fetching"); },
  });
  const meta = store.get("token_metadata", `${A}:${MAX_U256}`);
  assert.equal(meta?.metadataStatus, "failed");
  assert.match(meta.metadataError, /URI|method|alias/i);
  assert.ok(meta.metadataNextAttempt > Date.now());
  assert.equal(calls.length, 0);
  assert.equal(store.get("erc1155_balance", `${A}:${MAX_U256}:${OWNER}`).balance, "7");
});

test("discovered URI fetches enforce private-address and byte limits without blocking ownership reads", async (t) => {
  const { store } = fixture(t), calls = [], rpc = rpcFor([uriAbi("URI")], "http://127.0.0.1/private", calls);
  await refreshMetadata(store, rpc, config, { limit: 1 });
  const key = `${A}:${MAX_U256}`, first = store.get("token_metadata", key);
  assert.equal(first?.metadataStatus, "failed");
  assert.match(first.metadataError, /private|public|Forbidden|unsafe/i);
  store.put("metadata_job", key, { state: "pending" });
  await refreshMetadata(store, rpcFor([uriAbi("URI")], "https://example.org/large.json", calls), config,
    { limit: 1, fetchResource: async () => ({ bytes: Buffer.alloc(2 * 1024 * 1024 + 1, 32) }) });
  assert.match(store.get("token_metadata", key).metadataError, /size limit/i);
  assert.equal(store.get("erc1155_balance", `${key}:${OWNER}`).balance, "7");
});

test("legacy URI calldata follows its declared felt signature without truncating exact token IDs", async (t) => {
  const id = "9007199254740993", { store } = fixture(t, "ERC721", id), calls = [];
  await refreshMetadata(store, rpcFor([uriAbi("tokenURI", "felt")], "data:application/json,%7B%22name%22%3A%22Legacy%22%7D", calls), config, { limit: 1 });
  assert.equal(store.get("token", `${A}:${id}`).metadataStatus, "ready");
  assert.deepEqual(calls[0].calldata, ["0x20000000000001"]);
});

test("unsupported URI signatures and out-of-field IDs fail before the metadata contract call", async (t) => {
  for (const [name, type] of [["felt", "felt"], ["unknown", "core::byte_array::ByteArray"]]) {
    const { store } = fixture(t, "ERC721"), calls = [];
    await refreshMetadata(store, rpcFor([uriAbi("tokenURI", type)], "https://example.org/should-not-fetch", calls), config,
      { limit: 1, fetchResource: async () => { throw new Error("A proven encodable URI signature is required"); } });
    const metadata = store.get("token", `${A}:${MAX_U256}`);
    assert.equal(metadata.metadataStatus, "failed", name);
    assert.match(metadata.metadataError, /field|exceeds|signature|ABI/i);
    assert.equal(calls.length, 0, name);
  }
});

test("a class upgrade during a metadata fetch cannot cache the previous standard's URI result", async (t) => {
  const { store, record } = fixture(t), calls = [];
  await refreshMetadata(store, rpcFor([uriAbi("URI")], "https://example.org/old-class.json", calls), config, {
    limit: 1, fetchResource: async () => {
      store.put("catalog_collection", record.id, { ...record, standard: "ERC721", state: "unknown",
        classification: { ...record.classification, classHash: "0x456" } });
      return { bytes: Buffer.from('{"name":"Old class metadata"}') };
    },
  });
  assert.equal(store.get("token_metadata", `${A}:${MAX_U256}`), null);
  assert.equal(store.get("erc1155_balance", `${A}:${MAX_U256}:${OWNER}`).balance, "7");
});
