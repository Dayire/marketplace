import { ApiError, address, uint } from "./domain.mjs";
import { mapConcurrent } from "./concurrency.mjs";
import { collectionRecord } from "./collection-catalog.mjs";
import { discoveryKey } from "./discovery.mjs";
import { selectorFromName } from "./starknet-selector.mjs";
import {
  ABI_SUMMARY_VERSION,
  INTROSPECTION,
  classifyFromEvidence,
  classificationPatch,
  failedClassification,
  needsClassification,
  summarizeAbi,
} from "./classify.mjs";

const PROBE_ORDER = [
  { name: "isrc5", key: "isrc5" },
  { name: "erc721", key: "erc721" },
  { name: "erc1155", key: "erc1155" },
  { name: "erc721Legacy", key: "erc721Legacy" },
  { name: "erc2981", key: "erc2981" },
];

const supportedSelector = (value) => {
  try {
    return BigInt(value) === 1n;
  } catch {
    return false;
  }
};

async function supportsInterface(rpc, contract, blockId, interfaceId, method) {
  try {
    const result = await rpc.call("starknet_call", {
      request: {
        contract_address: contract,
        entry_point_selector: selectorFromName(method),
        calldata: [interfaceId],
      },
      block_id: blockId,
    });
    if (!Array.isArray(result) || result.length < 1)
      return { supported: false, error: "MALFORMED_RESPONSE" };
    return { supported: supportedSelector(result[0]) };
  } catch (error) {
    // Reverts and missing entrypoints mean "not supported", not a batch failure.
    return { supported: false, error: error?.code ?? "CALL_FAILED" };
  }
}

async function classSummary(rpc, store, classHash, blockId, cacheWrite = true) {
  const cached = await store.get("class_evidence", classHash);
  if (cached?.abiSummaryVersion === ABI_SUMMARY_VERSION && Array.isArray(cached.functions)) return cached;
  const contract = await rpc.call("starknet_getClass", {
    class_hash: classHash,
    block_id: blockId,
  });
  const summary = summarizeAbi(contract?.abi ?? [], { classHash });
  if (cacheWrite) await store.put("class_evidence", classHash, summary);
  return summary;
}

/** Resolve get_implementation(): may return an address or a class hash. */
async function resolveImplementation(rpc, store, value, blockId, cacheWrite, classHashOnly = false) {
  const raw = BigInt(uint(value, 252));
  const hash = "0x" + raw.toString(16);
  let asAddress = null;
  try {
    if (classHashOnly) throw new Error("The verified storage adapter stores a class hash");
    asAddress = address(hash);
    const targetClass = await rpc.call("starknet_getClassHashAt", {
      contract_address: asAddress,
      block_id: blockId,
    });
    const summary = await classSummary(rpc, store, targetClass, blockId, cacheWrite);
    return {
      address: asAddress,
      classHash: targetClass,
      summary,
      resolved: true,
    };
  } catch {
    try {
      const summary = await classSummary(
        rpc,
        store,
        hash,
        blockId,
        cacheWrite,
      );
      return {
        address: null,
        classHash: hash,
        summary,
        resolved: true,
      };
    } catch {
      return { address: asAddress, classHash: null, summary: null, resolved: false };
    }
  }
}

// Exact deployed bytecode identity, independently observed in the checked-in
// legacy-mainnet fixture. Other __default__ proxies cannot inherit this slot.
const OZ_CAIRO0_PROXY = "0x71429d7850e4421236ed7e4f58b7778fc0e0c01b8770335ba4140bcb13733e9";
const IMPLEMENTATION_GETTERS = ["get_implementation", "getImplementation", "implementation", "get_implementation_hash"];
function pinnedBlockId(value) {
  if (value?.block_hash != null) {
    try { uint(value.block_hash, 252); } catch { throw new ApiError("INVALID_BLOCK", "Expected a canonical block hash", 400); }
    return { block_hash: value.block_hash };
  }
  if (Number.isSafeInteger(value?.block_number) && value.block_number >= 0) return { block_number: value.block_number };
  throw new ApiError("INVALID_BLOCK", "Class evidence requires a pinned block hash or number", 400);
}

/**
 * Load immutable class evidence and resolve a supported proxy at one exact
 * chain position. This proves a block observation, never a complete proxy
 * upgrade interval. cacheWrite:false supports the metadata reader role.
 */
export async function resolveClassEvidence(rpc, store, { classHash, contractAddress, blockId, cacheWrite = true }) {
  const block = pinnedBlockId(blockId);
  const contract = address(contractAddress);
  const summary = await classSummary(rpc, store, classHash, block, cacheWrite);
  let implementation = null,
    proxyUncertainty = null;
  const proxyEvidence = [];
  const getters = IMPLEMENTATION_GETTERS.filter((method) => summary.zeroArgumentFunctions?.includes(method));
  for (const method of getters) {
    try {
      const value = await rpc.call("starknet_call", {
        request: {
          contract_address: contract,
          entry_point_selector: selectorFromName(method),
          calldata: [],
        },
        block_id: block,
      });
      if (Array.isArray(value) && value.length && BigInt(value[0]) !== 0n) {
        implementation = await resolveImplementation(
          rpc,
          store,
          value[0],
          block,
          cacheWrite,
        );
        proxyUncertainty = implementation.resolved
          ? "proxy_verified"
          : "proxy_unverified";
        proxyEvidence.push({ kind: "proxy_implementation", adapter: "implementation-getter.v1", method, blockId: block, proxyClassHash: classHash, implementationClassHash: implementation.classHash, resolved: implementation.resolved });
        if (implementation.resolved) break;
      } else {
        proxyUncertainty = "proxy_unverified";
        proxyEvidence.push({ kind: "proxy_implementation", adapter: "implementation-getter.v1", method, blockId: block, reason: "empty_implementation_getter" });
      }
    } catch (error) {
      proxyUncertainty = "proxy_unverified";
      proxyEvidence.push({ kind: "proxy_implementation", adapter: "implementation-getter.v1", method, blockId: block, reason: "implementation_getter_failed", code: error?.code ?? "CALL_FAILED" });
    }
  }
  if (!implementation?.resolved && BigInt(classHash) === BigInt(OZ_CAIRO0_PROXY)) {
    const storageKey = selectorFromName("Proxy_implementation_hash");
    const evidence = { kind: "proxy_implementation", adapter: "oz-cairo0-implementation-slot.v1", blockId: block, proxyClassHash: classHash, storageKey };
    try {
      const value = await rpc.call("starknet_getStorageAt", { contract_address: contract, key: storageKey, block_id: block });
      if (BigInt(value) === 0n) {
        proxyUncertainty = "proxy_unverified";
        proxyEvidence.push({ ...evidence, reason: "empty_implementation_slot" });
      } else {
        implementation = await resolveImplementation(rpc, store, value, block, cacheWrite, true);
        proxyUncertainty = implementation.resolved ? "proxy_verified" : "proxy_unverified";
        proxyEvidence.push({ ...evidence, implementationClassHash: implementation.classHash, resolved: implementation.resolved, ...(!implementation.resolved ? { reason: "implementation_class_unavailable" } : {}) });
      }
    } catch (error) {
      proxyUncertainty = "proxy_unverified";
      proxyEvidence.push({ ...evidence, reason: "implementation_slot_failed", code: error?.code ?? "CALL_FAILED" });
    }
  } else if (!implementation?.resolved && summary.functions.includes("__default__") && !proxyEvidence.length) {
    proxyUncertainty = "proxy_unverified";
    proxyEvidence.push({ kind: "proxy_implementation", blockId: block, proxyClassHash: classHash, reason: "unsupported_proxy_layout" });
  }
  if (implementation?.resolved) implementation.provenance = proxyEvidence.at(-1);
  return { summary, effectiveSummary: implementation?.summary ?? summary, implementation, proxyUncertainty, proxyEvidence };
}

async function classifyCandidate(rpc, store, record, block, hash) {
  const contract = address(record.address);
  const blockId = { block_hash: hash };
  const classHash = await rpc.call("starknet_getClassHashAt", { contract_address: contract, block_id: blockId });
  const resolved = await resolveClassEvidence(rpc, store, { classHash, contractAddress: contract, blockId });
  const { summary, effectiveSummary, implementation, proxyUncertainty, proxyEvidence } = resolved;
  const probes = [];
  const supports = ["supports_interface", "supportsInterface"].find((method) => effectiveSummary.functions.includes(method));
  if (supports) {
    for (const probe of PROBE_ORDER) {
      const outcome = await supportsInterface(rpc, contract, blockId, INTROSPECTION.interfaces[probe.key], supports);
      probes.push({ name: probe.name, interfaceId: INTROSPECTION.interfaces[probe.key], ...outcome });
    }
  }

  return classifyFromEvidence({
    summary,
    probes,
    implementation: implementation ?? null,
    proxyUncertainty,
    proxyEvidence,
    classHash,
    evidenceBlock: block,
    evidenceBlockHash: hash,
  });
}

/**
 * Classify bounded batches of discovery candidates (#111). Evidence is pinned
 * to the discovery checkpoint: the commit fails closed if that block's hash no
 * longer matches our anchors or the canonical journal.
 */
export async function classifyOnce(store, rpc, config, options = {}) {
  const opts = {
    limit: options.limit ?? 25,
    concurrency: options.concurrency ?? 4,
    maxAttempts: options.maxAttempts ?? 3,
  };
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 500)
    throw new ApiError("INVALID_LIMIT", "limit must be an integer from 1 to 500", 400);
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 32)
    throw new ApiError("INVALID_CONCURRENCY", "concurrency must be an integer from 1 to 32", 400);
  const started = performance.now();

  const coverage = await store.get("source_coverage", discoveryKey(config.chainId));
  if (!coverage || coverage.block == null)
    return { skipped: "no_discovery_checkpoint", classified: 0, failed: 0 };
  const block = coverage.block;

  const candidates = (await store.list("catalog_collection"))
    .filter((record) =>
      needsClassification(record, block, { maxAttempts: opts.maxAttempts }),
    )
    .sort((a, b) => Number(Boolean(a.classification)) - Number(Boolean(b.classification)) ||
      (a.classification?.evidenceBlock ?? -1) - (b.classification?.evidenceBlock ?? -1) || a.id.localeCompare(b.id))
    .slice(0, opts.limit);
  if (!candidates.length)
    return { skipped: "no_candidates", classified: 0, failed: 0, evidenceBlock: block };

  const outcomes = await mapConcurrent(
    candidates,
    opts.concurrency,
    async (record) => {
      try {
        return { record, result: await classifyCandidate(rpc, store, record, block, coverage.hash) };
      } catch (error) {
        return { record, error };
      }
    },
  );

  const generation = await store.generation();
  const writes = [];
  let classified = 0,
    failed = 0;
  for (const outcome of outcomes) {
    const { record, result, error } = outcome;
    const patch = result
      ? classificationPatch(record, result)
      : classificationPatch(record, failedClassification(record, error, block));
    if (!result) failed++;
    else classified++;
    const body = collectionRecord({
      ...record,
      ...patch,
      chainId: config.chainId,
      address: record.address,
      replayGeneration: generation,
    });
    writes.push({ id: body.id, body });
  }

  // Evidence for every outcome references the checkpoint block, so one anchor
  // check covers the whole batch: the checkpoint hash must match either the
  // discovery anchor or the canonical journal for that height.
  const expected = BigInt(coverage.hash);
  const assertAnchored = async () => {
    const anchor = await store.get("discovery_anchor", String(block));
    const journal = await store.canonicalBlock(block);
    const anchored =
      (anchor && BigInt(anchor.hash) === expected) ||
      (journal && BigInt(journal.hash) === expected);
    if (!anchored)
      throw new ApiError(
        "CHAIN_CONFLICT",
        `Discovery checkpoint ${block} no longer matches stored or canonical evidence`,
        409,
      );
  };

  // Classification writes ride at the checkpoint height so a discovery rewind
  // above that height removes them together with their evidence.
  if (store.dialect === "postgres") {
    await store.transaction(async () => {
      await assertAnchored();
      for (const write of writes)
        await store.put("catalog_collection", write.id, write.body, block);
    });
  } else {
    await assertAnchored();
    store.snapshot(() => {
      for (const write of writes)
        store.put("catalog_collection", write.id, write.body, block);
    });
  }

  return {
    classified,
    failed,
    candidates: candidates.length,
    evidenceBlock: block,
    elapsedMs: Math.round(performance.now() - started),
  };
}
