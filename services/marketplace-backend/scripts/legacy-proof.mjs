import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Store } from "../src/store.mjs";
import { RpcClient } from "../src/rpc.mjs";
import { address } from "../src/domain.mjs";
import { collectionRecord } from "../src/collection-catalog.mjs";
import { summarizeAbi, classifyFromEvidence, classificationPatch } from "../src/classify.mjs";
import { resolveClassEvidence } from "../src/classify-scan.mjs";
import { Catalog } from "../src/catalog.mjs";
import { decodeEvent } from "../src/decode.mjs";
import { reconcileCollection } from "../src/legacy-coverage.mjs";

// Read-only public-chain proof. Each case has a separate ephemeral projection;
// a receipt sample is never represented as a complete collection replay.
const sha = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const fixtureBytes = readFileSync(new URL("../test/fixtures/legacy-mainnet.json", import.meta.url), "utf8");
const fixture = JSON.parse(fixtureBytes);
const realmsBytes = readFileSync(new URL("../test/fixtures/realms-transfers.json", import.meta.url), "utf8");
const realms = JSON.parse(realmsBytes);
const rpcUrl = process.argv[2] ?? fixture.source;
const transport = new RpcClient([rpcUrl], { retries: 0, rateLimitRetries: 0, timeoutMs: 15000 });
const started = performance.now(), observations = [], cases = [];
const rpc = { async call(method, params) {
  const time = performance.now();
  try {
    const value = await transport.call(method, params);
    const record = { method, params, elapsedMs: Number((performance.now() - time).toFixed(3)), resultSha256: sha(value), resultBytes: Buffer.byteLength(JSON.stringify(value)) };
    if (method === "starknet_getClass") {
      const abi = typeof value.abi === "string" ? JSON.parse(value.abi) : value.abi;
      record.abiSha256 = sha(abi);
      const known = fixture.classes.find((item) => BigInt(item.classHash) === BigInt(params.class_hash));
      record.frozenAbiMatches = known != null && record.abiSha256 === known.abiSha256;
    } else if (method === "starknet_getTransactionReceipt") record.receiptEventCount = value.events.length;
    else if (method === "starknet_getBlockWithTxHashes") record.resultProjection = {
      block_number: value.block_number, block_hash: value.block_hash, parent_hash: value.parent_hash,
      timestamp: value.timestamp, status: value.status, transactionCount: value.transactions.length,
    };
    else record.result = value;
    observations.push(record);
    return value;
  } catch (error) {
    observations.push({ method, params, elapsedMs: Number((performance.now() - time).toFixed(3)), error: { code: error.code ?? "RPC_ERROR", message: error.message } });
    throw error;
  }
}};
const numericEvent = (event) => ({ source: address(event.from_address), keys: event.keys.map((v) => BigInt(v).toString()), data: event.data.map((v) => BigInt(v).toString()) });
const mint = fixture.receipts.find((item) => item.name === "briq-mint");
const input = [
  { name: "briq-cairo0-mint", event: mint.receipt.events[0], blockNumber: mint.blockNumber, blockHash: mint.blockHash, transactionHash: mint.receipt.transaction_hash, transactionIndex: mint.transactionIndex, eventIndex: 0, sourceClass: fixture.classes.find((item) => item.name === "briq-proxy"), effectiveClass: fixture.classes.find((item) => item.name === "briq-initial-implementation") },
  ...realms.events.map((event) => ({ name: `realms-mint-${BigInt(event.keys[3]) + (BigInt(event.keys[4]) << 128n)}`, event, blockNumber: event.block_number, blockHash: event.block_hash, transactionHash: event.transaction_hash, transactionIndex: event.transaction_index, eventIndex: event.event_index, sourceClass: fixture.classes.find((item) => item.name === "realms"), effectiveClass: fixture.classes.find((item) => item.name === "realms") })),
];
for (const sample of input) {
  const store = new Store(":memory:"), firstObservation = observations.length;
  try {
    const collection = address(sample.event.from_address), blockId = { block_hash: sample.blockHash };
    const receipt = await rpc.call("starknet_getTransactionReceipt", { transaction_hash: sample.transactionHash });
    const receiptMatches = JSON.stringify(numericEvent(receipt.events[sample.eventIndex])) === JSON.stringify(numericEvent(sample.event)) && BigInt(receipt.block_hash) === BigInt(sample.blockHash) && receipt.block_number === sample.blockNumber;
    if (!receiptMatches) throw new Error("Frozen mint differs from the public canonical receipt");
    const header = await rpc.call("starknet_getBlockWithTxHashes", { block_id: blockId });
    const summary = summarizeAbi(sample.effectiveClass.abi, { classHash: sample.effectiveClass.classHash });
    const classification = classifyFromEvidence({ summary });
    if (classification.standard !== "ERC721") throw new Error("Frozen ABI does not classify as ERC721");
    const config = { chain: "SN_MAIN", chainId: fixture.chainId, collections: [{ address: collection, startBlock: sample.blockNumber }], currencies: [] };
    const source = collectionRecord({ chainId: fixture.chainId, address: collection, standard: "ERC721", state: "syncing", classification: classification.classification });
    store.put("catalog_collection", source.id, source);
    const event = decodeEvent(sample.event, config, summary);
    store.applyBlock({ number: sample.blockNumber, hash: sample.blockHash, parentHash: header.parent_hash, timestamp: header.timestamp,
      events: [{ ...event, transactionHash: sample.transactionHash, eventIndex: sample.eventIndex, raw: sample.event }],
      sources: [collection], sourceStarts: { [collection]: sample.blockNumber } });
    const result = await reconcileCollection(store, rpc, config, { collection, blockNumber: sample.blockNumber, blockHash: sample.blockHash, limit: 25 });
    const effectiveHash = result.provenance?.implementationClassHash ?? result.provenance?.classHash;
    const classIdentityMatches = effectiveHash != null && BigInt(effectiveHash) === BigInt(sample.effectiveClass.classHash) && BigInt(result.provenance.classHash) === BigInt(sample.sourceClass.classHash);
    const caseObservations = observations.slice(firstObservation);
    const abiIdentityMatches = caseObservations.filter((item) => item.method === "starknet_getClass").every((item) => item.frozenAbiMatches);
    cases.push({ name: sample.name, collection, tokenId: event.tokenId, expectedOwner: event.to, transactionHash: sample.transactionHash,
      transactionIndex: sample.transactionIndex, eventIndex: sample.eventIndex, receiptMatches, classIdentityMatches, abiIdentityMatches,
      logicalRpcCalls: caseObservations.length, ok: result.ok && classIdentityMatches && abiIdentityMatches, reconciliation: result });
  } catch (error) {
    cases.push({ name: sample.name, ok: false, error: { code: error.code ?? "PROOF_FAILED", message: error.message } });
  } finally { store.close(); }
}
let negativeControl;
{
  const store = new Store(":memory:"), firstObservation = observations.length;
  try {
    const event = mint.receipt.events.at(-1), collection = address(event.from_address), blockId = { block_hash: mint.blockHash };
    const receipt = await rpc.call("starknet_getTransactionReceipt", { transaction_hash: mint.receipt.transaction_hash });
    const receiptMatches = JSON.stringify(numericEvent(receipt.events.at(-1))) === JSON.stringify(numericEvent(event));
    const classHash = await rpc.call("starknet_getClassHashAt", { contract_address: collection, block_id: blockId });
    const evidence = await resolveClassEvidence(rpc, store, { classHash, contractAddress: collection, blockId, cacheWrite: false });
    const classification = classifyFromEvidence({ summary: evidence.summary, implementation: evidence.implementation,
      proxyUncertainty: evidence.proxyUncertainty, proxyEvidence: evidence.proxyEvidence, classHash, evidenceBlock: mint.blockNumber, evidenceBlockHash: mint.blockHash });
    const seed = collectionRecord({ chainId: fixture.chainId, address: collection });
    const source = collectionRecord({ ...seed, ...classificationPatch(seed, classification) });
    store.put("catalog_collection", source.id, source);
    const coverage = new Catalog(store, { chain: "SN_MAIN", chainId: fixture.chainId, collections: [], currencies: [] }).coverage();
    let decoderRejected = false, decoderCode = null;
    try { decodeEvent(event, { collections: [{ address: collection }] }, evidence.effectiveSummary); }
    catch (error) { decoderRejected = true; decoderCode = error.code; }
    const recorded = coverage.unsupported.find((item) => item.address === collection);
    const abiIdentityMatches = observations.slice(firstObservation).filter((item) => item.method === "starknet_getClass").every((item) => item.frozenAbiMatches);
    negativeControl = { collection, block: mint.blockNumber, hash: mint.blockHash, receiptMatches, classHash,
      implementationClassHash: evidence.implementation?.classHash, classification, decoderRejected, decoderCode,
      operatorReason: recorded?.reason, abiIdentityMatches, logicalRpcCalls: observations.length - firstObservation,
      ok: receiptMatches && abiIdentityMatches && classification.standard === null && classification.classification.standard === "ERC20" && decoderRejected && recorded != null };
  } catch (error) { negativeControl = { ok: false, error: { code: error.code ?? "PROOF_FAILED", message: error.message } }; }
  finally { store.close(); }
}
const report = { schemaVersion: 1, capturedAt: new Date().toISOString(), source: new URL(rpcUrl).origin, chain: fixture.chain, chainId: fixture.chainId,
  runtime: process.version, scope: "Four individual frozen mint receipts replayed into isolated local projections and compared with live public getters at their exact historical block hashes",
  fixtureSha256: sha(fixtureBytes), realmsFixtureSha256: sha(realmsBytes), elapsedMs: Number((performance.now() - started).toFixed(3)),
  logicalRpcCalls: observations.length, ok: cases.every((item) => item.ok) && negativeControl.ok, cases, negativeControl, observations,
  limitations: ["This sample does not reconstruct any collection's full history", "Briq and Realms ABIs do not expose NFT total supply or token enumeration", "No production database or collection policy is changed"] };
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
