import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "../src/store.mjs";
import { summarizeAbi, ABI_SUMMARY_VERSION } from "../src/classify.mjs";
import { reconcileCollection } from "../src/legacy-coverage.mjs";
import { selectorFromName } from "../src/starknet-selector.mjs";
import { decodeEvent } from "../src/decode.mjs";
import { address, u256Felts } from "../src/domain.mjs";
import { collectionRecord } from "../src/collection-catalog.mjs";

const f = JSON.parse(readFileSync(new URL("./fixtures/legacy-mainnet.json", import.meta.url), "utf8"));
const c = (name) => f.classes.find((item) => item.name === name);
const pin = f.receipts.find((item) => item.name === "briq-mint");
const briq = address(pin.receipt.events[0].from_address);
const mint = pin.receipt.events[0];
const config = { chain: "SN_MAIN", chainId: f.chainId, collections: [{ address: briq, startBlock: 10423 }], currencies: [] };
const x = address("0xabc"), owner = address("0x22");
const token = "340282366920938463463374607431768211499";

const functionAbi = (name, inputs, output) => ({ type: "function", name, inputs: inputs.map(([n, type]) => ({ name: n, type })), outputs: [{ type: output }] });
const ownerAbi = functionAbi("owner_of", [["token_id", "core::integer::u256"]], "core::starknet::contract_address::ContractAddress");
const enumerableAbi = [ownerAbi, functionAbi("total_supply", [], "core::integer::u256"), functionAbi("token_by_index", [["index", "core::integer::u256"]], "core::integer::u256")];

function setup(t, { collection = x, standard = "ERC721", tokens = [token], balances = [], chainId = "0x1", block = 5, hash = "0x105" } = {}) {
  const store = new Store(":memory:"); t.after(() => store.close());
  const record = collectionRecord({ chainId, address: collection, state: "syncing", standard, decoderVersion: "nft-events.v2" });
  store.put("catalog_collection", record.id, record);
  store.applyBlock({ number: block, hash, parentHash: "0x104", timestamp: 1, events: [], progress: [] });
  for (const id of tokens) store.put("token", `${collection}:${id}`, { id: `${collection}:${id}`, collection, tokenId: id, owner, burned: false });
  for (const row of balances) store.put("erc1155_balance", `${collection}:${row.tokenId}:${row.owner}`, { collection, ...row });
  store.put("progress", collection, { block, hash, address: collection, chainId, startBlock: 0 });
  return { store, opts: { collection, blockHash: hash, blockNumber: block, limit: 10 }, config: { chain: "LOCAL", chainId, collections: [], currencies: [] } };
}

function modernRpc({ abi = enumerableAbi, ids = [token], owners = new Map([[token, owner]]), balances = new Map(), onCall, malformedOwner = false } = {}) {
  const calls = [];
  return { calls, async call(method, p) {
    calls.push({ method, params: p }); await onCall?.(method, p);
    if (method === "starknet_chainId") return "0x1";
    assert.deepEqual(p.block_id, { block_hash: "0x105" });
    if (method === "starknet_getBlockWithTxHashes") return { block_number: 5, block_hash: "0x105", status: "ACCEPTED_ON_L2" };
    if (method === "starknet_getClassHashAt") return "0x99";
    if (method === "starknet_getClass") return { abi };
    if (method !== "starknet_call") throw new Error(`Unexpected ${method}`);
    const request = p.request;
    assert.equal(address(request.contract_address), x);
    assert.ok(request.calldata.every((felt) => /^0x[0-9a-f]+$/.test(felt)), "wire calldata must be hexadecimal felts");
    if (request.entry_point_selector === selectorFromName("owner_of")) {
      const id = (BigInt(request.calldata[0]) + (BigInt(request.calldata[1]) << 128n)).toString();
      return malformedOwner ? ["0x22", "0x0"] : [owners.get(id) ?? "0x0"];
    }
    if (request.entry_point_selector === selectorFromName("total_supply")) return u256Felts(ids.length);
    if (request.entry_point_selector === selectorFromName("token_by_index")) return u256Felts(ids[Number(request.calldata[0])]);
    if (request.entry_point_selector === selectorFromName("balanceOf")) {
      const id = (BigInt(request.calldata[1]) + (BigInt(request.calldata[2]) << 128n)).toString();
      return u256Felts(balances.get(`${address(request.calldata[0])}:${id}`) ?? "0");
    }
    throw new Error("Unsupported entry point");
  }};
}

test("ABI summaries retain exact input/output signatures, including nested interfaces", () => {
  const s = summarizeAbi([{ type: "interface", name: "I", items: enumerableAbi }]);
  assert.equal(ABI_SUMMARY_VERSION, 3);
  assert.deepEqual(s.functionInputs.owner_of, ownerAbi.inputs);
  assert.deepEqual(s.functionOutputs.total_supply, [{ name: null, type: "core::integer::u256" }]);
});

test("frozen Cairo 0 mint projection reconciles ownerOf at the exact historical hash without inventing supply", async (t) => {
  const { store, opts } = setup(t, { collection: briq, chainId: f.chainId, tokens: [], block: pin.blockNumber, hash: pin.blockHash });
  const summary = summarizeAbi(c("briq-initial-implementation").abi);
  const decoded = decodeEvent(mint, config, summary);
  store.put("token", `${briq}:${decoded.tokenId}`, { id: `${briq}:${decoded.tokenId}`, ...decoded, owner: decoded.to, burned: false });
  const calls = [];
  const rpc = { async call(method, p) {
    calls.push({ method, params: p });
    if (method === "starknet_chainId") return f.chainId;
    assert.deepEqual(p.block_id, { block_hash: pin.blockHash });
    if (method === "starknet_getBlockWithTxHashes") return { block_number: pin.blockNumber, block_hash: pin.blockHash, status: "ACCEPTED_ON_L2" };
    if (method === "starknet_getClassHashAt") return c("briq-proxy").classHash;
    if (method === "starknet_getClass") return { abi: f.classes.find((item) => BigInt(item.classHash) === BigInt(p.class_hash)).abi };
    if (method === "starknet_getStorageAt") return c("briq-initial-implementation").classHash;
    if (method === "starknet_call") {
      assert.equal(p.request.entry_point_selector, selectorFromName("ownerOf"));
      assert.deepEqual(p.request.calldata, u256Felts(decoded.tokenId).map((felt) => "0x" + BigInt(felt).toString(16)));
      return f.observations.find((item) => item.name === "briq-owner-after-mint").response.result;
    }
    throw new Error(`Unexpected ${method}`);
  }};
  const result = await reconcileCollection(store, rpc, config, opts);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 1);
  assert.equal(result.projectedCount, "1");
  assert.equal(result.confidence, "partial");
  assert.ok(result.limitations.includes("total_supply_unavailable"));
  assert.ok(result.limitations.includes("enumeration_unavailable"));
  assert.equal(result.provenance.implementationClassHash, c("briq-initial-implementation").classHash);
  assert.deepEqual(store.get("status", `reconciliation:${briq}`), result);
  assert.equal(calls.filter((item) => item.method === "starknet_call").length, 1, "no undeclared supply or sequential-ID probes");
});

test("enumerable ERC721 compares exact owner, total supply and nonsequential token IDs", async (t) => {
  const { store, opts, config } = setup(t);
  const result = await reconcileCollection(store, modernRpc(), config, opts);
  assert.equal(result.ok, true);
  assert.equal(result.confidence, "complete");
  assert.equal(result.checked, 1);
  assert.equal(result.supply, "1");
  assert.deepEqual(result.limitations, []);
});

test("wrong owner or total supply blocks reconciliation", async (t) => {
  const { store, opts, config } = setup(t);
  const result = await reconcileCollection(store, modernRpc({ ids: [token, "999"], owners: new Map([[token, address("0x23")]]) }), config, opts);
  assert.equal(result.ok, false);
  assert.equal(result.state, "mismatch");
  assert.ok(result.mismatches.some((item) => item.kind === "owner" && item.tokenId === token));
  assert.ok(result.mismatches.some((item) => item.kind === "supply" && item.expected === "1" && item.actual === "2"));
});

test("bounded samples retain partial confidence even when every checked owner matches", async (t) => {
  const { store, opts, config } = setup(t, { tokens: [token, "999"] });
  const result = await reconcileCollection(store, modernRpc({ ids: ["999", token], owners: new Map([[token, owner], ["999", owner]]) }), config, { ...opts, limit: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.checked, 1);
  assert.equal(result.projectedCount, "2");
  assert.equal(result.confidence, "partial");
  assert.ok(result.limitations.includes("sample_limit"));
});

test("ERC1155 uses ABI-proven balanceOf(owner,u256), checking exact high amounts and retained zero rows", async (t) => {
  const rows = [{ tokenId: token, owner, balance: token }, { tokenId: "1", owner, balance: "0" }];
  const { store, opts, config } = setup(t, { standard: "ERC1155", tokens: [], balances: rows });
  const abi = [functionAbi("balanceOf", [["account", "felt"], ["id", "Uint256"]], "Uint256")];
  const result = await reconcileCollection(store, modernRpc({ abi, balances: new Map([[`${owner}:${token}`, token]]) }), config, opts);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 2);
  assert.equal(result.projectedCount, "2");
  assert.equal(result.confidence, "partial");
  assert.ok(result.limitations.includes("holder_enumeration_unavailable"));
});

test("unsupported getter signatures and malformed results produce explicit errors", async (t) => {
  const { store, opts, config } = setup(t);
  let result = await reconcileCollection(store, modernRpc({ abi: [functionAbi("owner_of", [["ids", "core::array::Array::<core::integer::u256>"]], "felt")] }), config, opts);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.code === "UNSUPPORTED_GETTER"));
  result = await reconcileCollection(store, modernRpc({ malformedOwner: true }), config, opts);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.code === "INVALID_GETTER_RESULT"));
});

test("source progress at another block is not compared with current projected ownership", async (t) => {
  const { store, opts, config } = setup(t);
  store.put("progress", x, { block: 6, hash: "0x106", address: x, startBlock: 0 });
  const result = await reconcileCollection(store, modernRpc(), config, opts);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.code === "PROJECTION_BLOCK_MISMATCH"));
});

test("a reorg during direct RPC checks cannot leave successful canonical status", async (t) => {
  const { store, opts, config } = setup(t);
  let changed = false;
  const rpc = modernRpc({ onCall(method) {
    if (method === "starknet_call" && !changed) { changed = true; store.rewind(4); }
  }});
  const result = await reconcileCollection(store, rpc, config, opts);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.code === "PROJECTION_CHANGED"));
  assert.equal(store.get("status", `reconciliation:${x}`), null, "stale observation is not persisted");
});

test("zero-token collections need supply/enumeration evidence before a successful result", async (t) => {
  const { store, opts, config } = setup(t, { tokens: [] });
  let result = await reconcileCollection(store, modernRpc({ abi: [ownerAbi], ids: [] }), config, opts);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.code === "NO_PROJECTED_SAMPLE"));
  result = await reconcileCollection(store, modernRpc({ ids: [] }), config, opts);
  assert.equal(result.ok, true);
  assert.equal(result.confidence, "complete");
});
