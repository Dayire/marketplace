import { createHash } from "node:crypto";
import { ApiError, address, uint, u256Felts, fromU256, boundedInteger } from "./domain.mjs";
import { collectionKey } from "./collection-catalog.mjs";
import { methodAliases } from "./classify.mjs";
import { resolveClassEvidence } from "./classify-scan.mjs";
import { selectorFromName } from "./starknet-selector.mjs";

const FELT_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const equal = (a, b) => a != null && b != null && BigInt(a) === BigInt(b);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const feltType = (type) => /^(felt|felt252|core::felt252)$/.test(type ?? "");
const addressType = (type) => feltType(type) || /(?:^|::)ContractAddress$/.test(type ?? "");
const integerType = (type) => {
  if (/^(Uint256|u256|core::integer::u256)$/.test(type ?? "")) return 256;
  if (feltType(type)) return 252;
  const match = /^(?:core::integer::)?u(8|16|32|64|128)$/.exec(type ?? "");
  return match ? Number(match[1]) : null;
};
function encodeInteger(value, type) {
  const bits = integerType(type);
  if (bits == null) throw new ApiError("UNSUPPORTED_GETTER", "Unsupported getter integer type");
  const n = uint(value, bits);
  if (bits === 256) return u256Felts(n).map((felt) => "0x" + BigInt(felt).toString(16));
  if (bits === 252 && BigInt(n) >= FELT_PRIME) throw new ApiError("INVALID_INTEGER", "Getter calldata exceeds the Starknet field");
  return ["0x" + BigInt(n).toString(16)];
}
function integerResult(values, type) {
  const bits = integerType(type);
  if (!Array.isArray(values) || bits == null || values.length !== (bits === 256 ? 2 : 1))
    throw new ApiError("INVALID_GETTER_RESULT", "Getter result does not match its declared integer type");
  try {
    const value = bits === 256 ? fromU256(...values) : uint(values[0], bits);
    if (bits === 252 && BigInt(value) >= FELT_PRIME) throw new Error("Invalid felt");
    return value;
  } catch { throw new ApiError("INVALID_GETTER_RESULT", "Getter returned an invalid unsigned integer"); }
}
function getter(summary, canonical, accepts) {
  for (const name of methodAliases(summary)[canonical] ?? []) {
    const inputs = summary.functionInputs?.[name], outputs = summary.functionOutputs?.[name];
    if (Array.isArray(inputs) && Array.isArray(outputs) && outputs.length === 1 && accepts(inputs, outputs[0].type))
      return { name, inputs, output: outputs[0].type };
  }
  return null;
}
const ownerGetter = (summary) => getter(summary, "owner_of", (inputs, output) => inputs.length === 1 && integerType(inputs[0].type) != null && addressType(output));
const balanceGetter = (summary) => getter(summary, "balance_of", (inputs, output) => inputs.length === 2 && addressType(inputs[0].type) && integerType(inputs[1].type) != null && integerType(output) != null);
const supplyGetter = (summary) => getter(summary, "total_supply", (inputs, output) => inputs.length === 0 && integerType(output) != null);
const enumerationGetter = (summary) => getter(summary, "token_by_index", (inputs, output) => inputs.length === 1 && integerType(inputs[0].type) != null && integerType(output) != null);

function fingerprint(view) {
  return digest({ generation: view.generation, canonical: view.canonical, progress: view.progress, count: view.count, rows: view.rows,
    source: view.source && { standard: view.source.standard, decoderVersion: view.source.decoderVersion, classHistory: view.source.classHistory, replayGeneration: view.source.replayGeneration, quarantine: view.source.quarantine } });
}
function sqliteView(store, chainId, collection, blockNumber, limit) {
  const source = store.get("catalog_collection", collectionKey(chainId, collection));
  const kind = source?.standard === "ERC1155" ? "erc1155_balance" : "token";
  const filter = "kind=? AND json_extract(body,'$.collection')=?" + (kind === "token" ? " AND COALESCE(json_extract(body,'$.burned'),0)=0" : "");
  const count = store.db.prepare(`SELECT CAST(count(*) AS TEXT) AS count FROM entities WHERE ${filter}`).get(kind, collection).count;
  const rows = store.db.prepare(`SELECT body FROM entities WHERE ${filter} ORDER BY num_key,id LIMIT ?`).all(kind, collection, limit).map((row) => JSON.parse(row.body));
  return { source, count, rows, generation: store.generation(), canonical: store.canonicalBlock(blockNumber), progress: store.get("progress", collection) };
}
async function postgresView(store, chainId, collection, blockNumber, limit) {
  const source = await store.get("catalog_collection", collectionKey(chainId, collection));
  const erc1155 = source?.standard === "ERC1155";
  const table = erc1155 ? "market.erc1155_balances" : "market.tokens";
  const filter = "collection=$1" + (erc1155 ? "" : " AND NOT burned");
  const count = (await store.query(`SELECT count(*)::text AS count FROM ${table} WHERE ${filter}`, [collection])).rows[0].count;
  const rows = (await store.query(`SELECT body FROM ${table} WHERE ${filter} ORDER BY token_id${erc1155 ? ",owner" : ""} LIMIT $2`, [collection, limit])).rows.map((row) => row.body);
  return { source, count, rows, generation: await store.generation(), canonical: await store.canonicalBlock(blockNumber), progress: await store.get("progress", collection) };
}
async function readView(store, chainId, collection, blockNumber, limit) {
  if (store.dialect !== "postgres") return store.snapshot(() => sqliteView(store, chainId, collection, blockNumber, limit));
  const snapshot = await store.beginSnapshot();
  try { return await postgresView(snapshot, chainId, collection, blockNumber, limit); }
  finally { await snapshot.endSnapshot(); }
}

/**
 * Independently compare a bounded projection with declared getters at one
 * immutable block hash. This is observation evidence, never trading policy.
 * No sequential token IDs, voting supply or synthetic ERC1155 owners are used.
 */
export async function reconcileCollection(store, rpc, config, { collection, blockHash, blockNumber, limit = 25 }) {
  collection = address(collection);
  const hash = "0x" + BigInt(uint(blockHash, 252)).toString(16);
  if (BigInt(hash) >= FELT_PRIME || !Number.isSafeInteger(blockNumber) || blockNumber < 0)
    throw new ApiError("INVALID_RECONCILIATION_BLOCK", "Reconciliation requires a valid exact block hash and number");
  limit = boundedInteger(limit, 25, 500);
  const blockId = { block_hash: hash };
  const view = await readView(store, config.chainId, collection, blockNumber, limit);
  const result = { state: "unavailable", ok: false, confidence: "partial", checked: 0, projectedCount: view.count,
    mismatches: [], errors: [], limitations: [], block: blockNumber, hash, replayGeneration: view.generation, observedAt: Date.now(), supply: null };
  let hadError = false, hadMismatch = false;
  const error = (code, message, detail = {}) => { hadError = true; if (result.errors.length < limit) result.errors.push({ code, message: String(message).slice(0, 300), ...detail }); else if (!result.limitations.includes("detail_limit")) result.limitations.push("detail_limit"); };
  const mismatch = (value) => { hadMismatch = true; if (result.mismatches.length < limit) result.mismatches.push(value); else if (!result.limitations.includes("detail_limit")) result.limitations.push("detail_limit"); };
  const limitation = (code) => { if (!result.limitations.includes(code)) result.limitations.push(code); };
  if (!view.source || !["ERC721", "ERC1155"].includes(view.source.standard)) error("UNSUPPORTED_STANDARD", "A positively classified collection is required");
  if (!equal(view.canonical?.hash, hash)) error("CANONICAL_BLOCK_MISMATCH", "Projection does not retain the requested canonical hash");
  if (view.progress?.block !== blockNumber || !equal(view.progress?.hash, hash)) error("PROJECTION_BLOCK_MISMATCH", "Collection projection progress must equal the requested block");
  if (BigInt(view.count) > BigInt(limit)) limitation("sample_limit");
  let enumerableComplete = false;
  if (!hadError) {
    try {
      if (!equal(await rpc.call("starknet_chainId", {}), config.chainId)) throw new ApiError("CHAIN_ID_MISMATCH", "RPC chain does not match the configured chain");
      const header = await rpc.call("starknet_getBlockWithTxHashes", { block_id: blockId });
      if (header.block_number !== blockNumber || !equal(header.block_hash, hash)) throw new ApiError("RPC_BLOCK_MISMATCH", "RPC returned a different block");
      const classHash = await rpc.call("starknet_getClassHashAt", { block_id: blockId, contract_address: collection });
      const evidence = await resolveClassEvidence(rpc, store, { classHash, contractAddress: collection, blockId, cacheWrite: false });
      if (evidence.proxyUncertainty === "proxy_unverified") throw new ApiError("UNRESOLVED_IMPLEMENTATION", "Proxy implementation is not proven at the requested hash");
      const summary = evidence.effectiveSummary;
      result.provenance = { source: "direct_rpc", chainId: config.chainId, classHash, implementationClassHash: evidence.implementation?.classHash ?? null,
        blockId, aliases: methodAliases(summary), proxyEvidence: evidence.proxyEvidence, projectionDigest: fingerprint(view) };
      const call = (method, calldata) => rpc.call("starknet_call", { request: { contract_address: collection, entry_point_selector: selectorFromName(method.name), calldata }, block_id: blockId });
      const method = view.source.standard === "ERC721" ? ownerGetter(summary) : balanceGetter(summary);
      if (!method) error("UNSUPPORTED_GETTER", "The ABI does not prove a supported owner or balance getter signature");
      else for (const row of view.rows) {
        const detail = { tokenId: uint(row.tokenId), method: method.name, ...(view.source.standard === "ERC1155" ? { owner: address(row.owner) } : {}) };
        try {
          const calldata = encodeInteger(row.tokenId, method.inputs.at(-1).type);
          if (view.source.standard === "ERC1155") calldata.unshift(address(row.owner));
          const values = await call(method, calldata);
          let actual, expected;
          if (view.source.standard === "ERC721") {
            if (!Array.isArray(values) || values.length !== 1) throw new ApiError("INVALID_GETTER_RESULT", "Owner getter must return exactly one address felt");
            try { actual = address(values[0]); } catch { throw new ApiError("INVALID_GETTER_RESULT", "Owner getter returned an invalid address"); }
            expected = address(row.owner);
          } else { actual = integerResult(values, method.output); expected = uint(row.balance); }
          result.checked++;
          if (actual !== expected) mismatch({ kind: view.source.standard === "ERC721" ? "owner" : "balance", ...detail, expected, actual });
        } catch (e) { error(e.code ?? "GETTER_FAILED", e.message, detail); }
      }
      if (view.source.standard === "ERC721") {
        const supply = supplyGetter(summary), enumeration = enumerationGetter(summary);
        if (!supply) limitation("total_supply_unavailable");
        else try {
          result.supply = integerResult(await call(supply, []), supply.output);
          if (result.supply !== view.count) mismatch({ kind: "supply", method: supply.name, expected: view.count, actual: result.supply });
        } catch (e) { error(e.code ?? "GETTER_FAILED", e.message, { method: supply.name }); }
        if (!enumeration) limitation("enumeration_unavailable");
        if (result.supply != null && enumeration && BigInt(result.supply) <= BigInt(limit) && result.supply === view.count) {
          const projected = new Set(view.rows.map((row) => uint(row.tokenId))), seen = new Set();
          for (let index = 0; index < Number(result.supply); index++) {
            try {
              const id = integerResult(await call(enumeration, encodeInteger(index, enumeration.inputs[0].type)), enumeration.output);
              if (seen.has(id) || !projected.has(id)) mismatch({ kind: "enumeration", method: enumeration.name, index, expected: "unique projected token ID", actual: id });
              seen.add(id);
            } catch (e) { error(e.code ?? "GETTER_FAILED", e.message, { method: enumeration.name, index }); }
          }
          enumerableComplete = seen.size === Number(result.supply) && result.checked === view.rows.length && view.rows.length === Number(view.count);
        }
      } else limitation("holder_enumeration_unavailable");
      if (result.checked === 0 && !enumerableComplete) error("NO_PROJECTED_SAMPLE", "No projected owner or balance was independently checked");
    } catch (e) { error(e.code ?? "RECONCILIATION_RPC_FAILED", e.message); }
  }
  result.ok = !hadError && !hadMismatch;
  result.state = hadError ? "unavailable" : hadMismatch ? "mismatch" : "matched";
  result.confidence = result.ok && enumerableComplete ? "complete" : "partial";
  let changed = false;
  const persist = async () => {
    const current = await postgresView(store, config.chainId, collection, blockNumber, limit);
    if (fingerprint(current) !== fingerprint(view) || !equal(current.canonical?.hash, hash)) { changed = true; return; }
    await store.put("status", `reconciliation:${collection}`, result, blockNumber);
  };
  if (store.dialect === "postgres") await store.transaction(persist);
  else store.snapshot(() => {
    const current = sqliteView(store, config.chainId, collection, blockNumber, limit);
    if (fingerprint(current) !== fingerprint(view) || !equal(current.canonical?.hash, hash)) { changed = true; return; }
    store.put("status", `reconciliation:${collection}`, result, blockNumber);
  });
  if (changed) { error("PROJECTION_CHANGED", "Canonical projection changed during reconciliation; observation was not persisted"); result.ok = false; result.state = "unavailable"; result.confidence = "partial"; }
  return result;
}
