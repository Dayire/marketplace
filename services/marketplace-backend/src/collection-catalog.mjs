import { address, uint, ApiError } from "./domain.mjs";

export const COLLECTION_STATES = Object.freeze([
  "unknown",
  "candidate",
  "syncing",
  "indexed",
  "unsupported",
  "failed",
]);
const invalid = (message) => {
  throw new ApiError("INVALID_CATALOG", message);
};
const integer = (value, label, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum)
    invalid(`Invalid ${label}`);
  return value;
};
const nullableInteger = (value, label) =>
  value == null ? null : integer(value, label);
const hex = (value) => {
  const n = BigInt(uint(value, 252));
  if (n >= (1n << 251n) + 17n * (1n << 192n) + 1n) invalid("Invalid felt");
  return "0x" + n.toString(16);
};
export const collectionKey = (chainId, collection) =>
  `${hex(chainId)}:${address(collection)}`;
const identity = (value) => {
  const chainId = hex(value.chainId),
    collection = address(value.address);
  return {
    id: collectionKey(chainId, collection),
    chainId,
    address: collection,
  };
};
function position(value) {
  return value == null
    ? null
    : {
        block: integer(value.block, "provenance block"),
        hash: hex(value.hash),
        transactionIndex: nullableInteger(
          value.transactionIndex,
          "transaction index",
        ),
        eventIndex: nullableInteger(value.eventIndex, "event index"),
      };
}
const version = (value) => {
  if (value == null) return null;
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(value))
    invalid("Invalid decoder version");
  return value;
};
const jsonEvidence = (value) => {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    invalid("Evidence must be an object");
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 32768) invalid("Evidence is too large");
  return JSON.parse(json);
};

/** Chain facts only. Discovery callers cannot set operator or settlement policy. */
export function collectionRecord(value) {
  for (const key of ["visible", "verified", "tradable"])
    if (Object.hasOwn(value, key))
      invalid("Catalog evidence cannot set policy");
  const state = value.state ?? "unknown",
    standard = value.standard ?? null;
  if (!COLLECTION_STATES.includes(state)) invalid("Invalid collection state");
  if (standard !== null && !["ERC721", "ERC1155"].includes(standard))
    invalid("Invalid NFT standard");
  const history = value.classHistory ?? [];
  if (!Array.isArray(history) || history.length > 128)
    invalid("Invalid class history");
  const result = {
    ...identity(value),
    state,
    standard,
    deployment: position(value.deployment),
    classHistory: history.map((interval) => {
      const from = position(interval.from),
        to = position(interval.to);
      if (!from || (to && to.block < from.block))
        invalid("Invalid class interval");
      return {
        classHash: hex(interval.classHash),
        from,
        to,
        decoderVersion: version(interval.decoderVersion),
      };
    }),
    classification: jsonEvidence(value.classification),
    decoderVersion: version(value.decoderVersion),
    replayGeneration: integer(
      value.replayGeneration ?? 1,
      "replay generation",
      1,
    ),
  };
  if (value.quarantine != null)
    result.quarantine = quarantineEvidence(value.quarantine);
  if (value.id != null && value.id !== result.id)
    invalid("Catalog identity mismatch");
  return result;
}

/** Bounded decode-quarantine evidence written by the scanner (#112). */
function quarantineEvidence(value) {
  if (typeof value !== "object") invalid("Invalid quarantine evidence");
  const entry = (label, item) => {
    if (item == null || typeof item !== "object")
      invalid(`Invalid ${label} quarantine entry`);
    const message = String(item.message ?? "");
    if (message.length > 240) invalid(`Quarantine ${label} message too long`);
    return {
      block: integer(item.block, `${label} quarantine block`),
      transactionHash: String(item.transactionHash ?? ""),
      eventIndex: integer(item.eventIndex, `${label} quarantine event index`),
      code: String(item.code ?? ""),
      message,
      selector: item.selector == null ? null : hex(item.selector),
    };
  };
  return {
    observations: integer(value.observations, "quarantine observations", 1),
    first: entry("first", value.first),
    last: entry("last", value.last),
  };
}

/** Coverage is independent of classification and product policy. Nulls remain unknown. */
export function sourceCoverage(value) {
  const startBlock = nullableInteger(value.startBlock, "coverage start"),
    block = nullableInteger(value.block, "checkpoint"),
    hash = value.hash == null ? null : hex(value.hash),
    gaps = value.gaps ?? [],
    mode = value.mode ?? "catalog",
    sourceType = value.sourceType ?? "nft";
  if ((block === null) !== (hash === null))
    invalid("Checkpoint requires both block and hash");
  if (block !== null && startBlock !== null && startBlock > block)
    invalid("Coverage start exceeds checkpoint");
  if (!["catalog", "configured_scan"].includes(mode))
    invalid("Invalid coverage mode");
  if (!["nft", "marketplace", "discovery"].includes(sourceType))
    invalid("Invalid source type");
  if (!Array.isArray(gaps) || gaps.length > 100)
    invalid("Coverage must have at most 100 gaps");
  const result = {
    ...identity(value),
    sourceType,
    mode,
    startBlock,
    block,
    hash,
    observedAt: nullableInteger(value.observedAt, "observation time"),
    replayGeneration: integer(
      value.replayGeneration ?? 1,
      "replay generation",
      1,
    ),
    gaps: gaps.map((gap) => {
      const from = integer(gap.from, "gap start"),
        to = integer(gap.to, "gap end");
      if (
        to < from ||
        typeof gap.reason !== "string" ||
        !gap.reason.trim() ||
        gap.reason.length > 500
      )
        invalid("Invalid coverage gap");
      return { from, to, reason: gap.reason };
    }),
  };
  if (value.id != null && value.id !== result.id)
    invalid("Coverage identity mismatch");
  return result;
}

/** A readiness answer is valid only for the exact sources requested by the caller. */
export function sourceReadiness(
  required,
  coverage,
  {
    rpc,
    generation,
    canonicalHashes = {},
    now = Date.now(),
    maxLag = 2,
    maxAge = 15000,
  } = {},
) {
  if (!Array.isArray(required) || required.length > 1000)
    invalid("Invalid readiness scope");
  integer(generation, "read generation", 1);
  integer(now, "current time");
  integer(maxLag, "maximum lag");
  integer(maxAge, "maximum age");
  const records = new Map(coverage.filter(Boolean).map((c) => [c.id, c]));
  const reasons = new Set();
  if (!required.length) reasons.add("NO_SOURCES");
  if (
    !rpc ||
    !Number.isSafeInteger(rpc.head) ||
    rpc.head < 0 ||
    !Number.isSafeInteger(rpc.observedAt) ||
    rpc.observedAt > now ||
    now - rpc.observedAt > maxAge
  )
    reasons.add("HEAD_STALE");
  if (!rpc?.identityVerified) reasons.add("IDENTITY_UNVERIFIED");
  if (rpc?.error) reasons.add("RPC_ERROR");
  const sources = required.map((source) => {
    const id = collectionKey(source.chainId, source.address),
      c = records.get(id),
      local = [];
    if (!c || c.block == null) local.push("SOURCE_SYNCING");
    if (c && c.replayGeneration !== generation)
      local.push("GENERATION_MISMATCH");
    if (
      !Number.isSafeInteger(source.requiredStartBlock) ||
      source.requiredStartBlock < 0 ||
      c?.startBlock == null ||
      c.startBlock > source.requiredStartBlock
    )
      local.push("SOURCE_BACKFILL_REQUIRED");
    if (c?.gaps.length) local.push("HISTORY_GAP");
    if (
      c?.block != null &&
      (canonicalHashes[c.block] == null ||
        hex(canonicalHashes[c.block]) !== c.hash)
    )
      local.push("CHECKPOINT_UNVERIFIED");
    if (
      c?.block != null &&
      (!Number.isSafeInteger(rpc?.head) ||
        c.block > rpc.head ||
        rpc.head - c.block > maxLag)
    )
      local.push("INDEX_STALE");
    if (
      c?.observedAt == null ||
      c.observedAt > now ||
      now - c.observedAt > maxAge
    )
      local.push("SOURCE_STALE");
    for (const reason of local) reasons.add(reason);
    return { id, coverage: c ?? null, ready: !local.length, reasons: local };
  });
  return {
    ready: !reasons.size,
    generation,
    sources,
    reasons: [...reasons],
    chainHead: rpc?.head ?? null,
    observedAt: rpc?.observedAt ?? null,
  };
}
