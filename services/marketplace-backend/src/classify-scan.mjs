import { ApiError, address } from "./domain.mjs";
import { mapConcurrent } from "./concurrency.mjs";
import { collectionRecord } from "./collection-catalog.mjs";
import { discoveryKey } from "./discovery.mjs";
import {
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

async function supportsInterface(rpc, contract, block, interfaceId) {
  try {
    const result = await rpc.call("starknet_call", {
      request: {
        contract_address: contract,
        entry_point_selector: INTROSPECTION.selectors.supports_interface,
        calldata: [interfaceId],
      },
      block_id: block,
    });
    if (!Array.isArray(result) || result.length < 1)
      return { supported: false, error: "MALFORMED_RESPONSE" };
    return { supported: supportedSelector(result[0]) };
  } catch (error) {
    // Reverts and missing entrypoints mean "not supported", not a batch failure.
    return { supported: false, error: error?.code ?? "CALL_FAILED" };
  }
}

async function classSummary(rpc, store, classHash, block) {
  const cached = await store.get("class_evidence", classHash);
  if (cached && Array.isArray(cached.functions)) return cached;
  const contract = await rpc.call("starknet_getClass", {
    class_hash: classHash,
    block_id: { block_number: block },
  });
  const summary = summarizeAbi(contract?.abi ?? [], { classHash });
  await store.put("class_evidence", classHash, summary);
  return summary;
}

/** Resolve get_implementation(): may return an address or a class hash. */
async function resolveImplementation(rpc, store, value, block) {
  const raw = typeof value === "bigint" ? value : BigInt(value);
  const asAddress = address("0x" + raw.toString(16));
  try {
    const targetClass = await rpc.call("starknet_getClassHashAt", {
      contract_address: asAddress,
      block_id: { block_number: block },
    });
    const summary = await classSummary(rpc, store, targetClass, block);
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
        "0x" + raw.toString(16),
        block,
      );
      return {
        address: null,
        classHash: "0x" + raw.toString(16),
        summary,
        resolved: true,
      };
    } catch {
      return { address: asAddress, classHash: null, summary: null, resolved: false };
    }
  }
}

async function classifyCandidate(rpc, store, record, block) {
  const contract = address(record.address);
  const classHash = await rpc.call("starknet_getClassHashAt", {
    contract_address: contract,
    block_id: { block_number: block },
  });
  const summary = await classSummary(rpc, store, classHash, block);

  const probes = [];
  if (summary.functions.includes("supports_interface")) {
    for (const probe of PROBE_ORDER) {
      const outcome = await supportsInterface(
        rpc,
        contract,
        block,
        INTROSPECTION.interfaces[probe.key],
      );
      probes.push({
        name: probe.name,
        interfaceId: INTROSPECTION.interfaces[probe.key],
        ...outcome,
      });
    }
  }

  let implementation = null,
    proxyUncertainty = null;
  if (summary.functions.includes("get_implementation")) {
    try {
      const value = await rpc.call("starknet_call", {
        request: {
          contract_address: contract,
          entry_point_selector: INTROSPECTION.selectors.get_implementation,
          calldata: [],
        },
        block_id: { block_number: block },
      });
      if (Array.isArray(value) && value.length && BigInt(value[0]) !== 0n) {
        implementation = await resolveImplementation(
          rpc,
          store,
          value[0],
          block,
        );
        proxyUncertainty = implementation.resolved
          ? "proxy_verified"
          : "proxy_unverified";
      }
    } catch {
      proxyUncertainty = "proxy_unverified";
    }
  }

  return classifyFromEvidence({
    summary,
    probes,
    implementation: implementation ?? null,
    proxyUncertainty,
    classHash,
    evidenceBlock: block,
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
    .slice(0, opts.limit);
  if (!candidates.length)
    return { skipped: "no_candidates", classified: 0, failed: 0, evidenceBlock: block };

  const outcomes = await mapConcurrent(
    candidates,
    opts.concurrency,
    async (record) => {
      try {
        return { record, result: await classifyCandidate(rpc, store, record, block) };
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
