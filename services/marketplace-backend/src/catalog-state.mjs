import { address } from "./domain.mjs";
import { sourceCoverage, sourceReadiness } from "./collection-catalog.mjs";

/** Publishing, verification and settlement permission are separate decisions. */
export function collectionVisible(config, raw, { registered, record, visibility, restricted }) {
  if (restricted) return false;
  if (typeof visibility?.visible === "boolean") return visibility.visible;
  const configured = (config.collections ?? []).some((c) => address(c.address) === address(raw));
  // Preserve legacy registered reads before a discovery record exists. A newly
  // discovered contract cannot publish itself by acquiring a metadata row.
  return configured || (!!registered && !record);
}

export function publicChainState(config, raw, {
  record, saved, progress, rpc, generation, canonicalHash, reconciliation, now = Date.now(),
}) {
  const a = address(raw);
  const configured = (config.collections ?? []).find((c) => address(c.address) === a);
  let coverage = saved;
  if ((saved?.mode === "configured_scan") || (!saved && progress)) {
    coverage = config.chainId ? sourceCoverage({
      ...saved, ...progress, chainId: config.chainId, address: a, mode: "configured_scan",
      block: progress?.hash != null ? progress.block : null,
      hash: progress?.block != null ? progress.hash : null,
      startBlock: progress?.startBlock ?? null, observedAt: progress?.observedAt ?? null,
      replayGeneration: generation,
    }) : null;
  }
  let source = null;
  if (config.chainId) {
    const readiness = sourceReadiness([{ chainId: config.chainId, address: a,
      requiredStartBlock: configured?.startBlock ?? record?.deployment?.block,
    }], [coverage].filter(Boolean), {
      rpc, generation, canonicalHashes: coverage?.block != null ? { [coverage.block]: canonicalHash } : {}, now,
    });
    const reasons = [...readiness.reasons];
    if (record?.replayGeneration !== undefined && record.replayGeneration !== generation)
      reasons.push("GENERATION_MISMATCH");
    if (record && !["indexed", "unsupported", "failed"].includes(record.state)) reasons.push("SOURCE_SYNCING");
    if (record?.state === "failed") reasons.push("SOURCE_FAILED");
    if (record?.state === "unsupported") reasons.push("SOURCE_UNSUPPORTED");
    if (record && !["ERC721", "ERC1155"].includes(record.standard)) reasons.push("SOURCE_UNCLASSIFIED");
    if (reconciliation?.replayGeneration === generation && reconciliation.ok !== true)
      reasons.push("RECONCILIATION_FAILED");
    source = { ready: reasons.length === 0, reasons: [...new Set(reasons)], generation,
      chainHead: readiness.chainHead, observedAt: readiness.observedAt };
  }
  // Keep the original configured progress shape stable; explicit discovery
  // coverage includes its generation, gaps and independent source identity.
  const publicCoverage = saved ? coverage : progress ? {
    startBlock: progress.startBlock ?? null, block: progress.block ?? null,
    hash: progress.hash ?? null, observedAt: progress.observedAt ?? null,
  } : null;
  const currentReconciliation = reconciliation?.replayGeneration === generation ? {
    state: reconciliation.state ?? null, ok: reconciliation.ok === true,
    confidence: reconciliation.confidence === "complete" ? "complete" : "partial",
    checked: reconciliation.checked ?? null,
    projectedCount: reconciliation.projectedCount == null ? null : String(reconciliation.projectedCount),
    mismatches: Array.isArray(reconciliation.mismatches) ? reconciliation.mismatches.slice(0, 100) : [],
    errors: Array.isArray(reconciliation.errors) ? reconciliation.errors.slice(0, 100) : [],
    limitations: Array.isArray(reconciliation.limitations) ? reconciliation.limitations.slice(0, 100) : [],
    block: reconciliation.block ?? null, hash: reconciliation.hash ?? null,
    replayGeneration: reconciliation.replayGeneration, observedAt: reconciliation.observedAt ?? null,
    ...(reconciliation.supply != null ? { supply: String(reconciliation.supply) } : {}),
  } : null;
  return {
    coverage: publicCoverage,
    source,
    reconciliation: currentReconciliation,
    basis: "indexed",
    generation,
    chain: record ? {
      state: record.state, standard: record.standard,
      method: record.classification?.method ?? null,
      uncertainty: record.classification?.uncertainty ?? null,
      decoderVersion: record.decoderVersion ?? null,
      replayGeneration: record.replayGeneration,
    } : null,
  };
}
