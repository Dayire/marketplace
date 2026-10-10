import { readFileSync } from "node:fs";
import { ApiError } from "./domain.mjs";
import { activeClassInterval } from "./discovery.mjs";

/** Interface ids and entrypoint selectors for contract classification (#111). */
export const INTROSPECTION = JSON.parse(
  readFileSync(
    new URL("../../../config/marketplace/introspection.json", import.meta.url),
    "utf8",
  ),
);

const ERC721_FUNCTIONS = [
  "owner_of",
  "transfer_from",
  "safe_transfer_from",
  "approve",
  "get_approved",
  "is_approved_for_all",
];
const ERC721_ALIASES = {
  balance_of: ["balance_of", "balanceOf"],
  owner_of: ["owner_of", "ownerOf"],
  token_uri: ["token_uri", "tokenURI"],
  transfer_from: ["transfer_from", "transferFrom"],
  safe_transfer_from: ["safe_transfer_from", "safeTransferFrom"],
  approve: ["approve"],
  get_approved: ["get_approved", "getApproved"],
  is_approved_for_all: ["is_approved_for_all", "isApprovedForAll"],
};
const ERC20_FUNCTIONS = ["decimals", "symbol", "name", "transfer", "allowance"];
const ERC1155_FUNCTIONS = [
  "safe_batch_transfer_from",
  "balance_of_batch",
  "uri",
  "mint",
];
const LAYOUT_EVENTS = [
  "Transfer",
  "Approval",
  "ApprovalForAll",
  "MetadataUpdate",
  "BatchMetadataUpdate",
];

/**
 * Reduce a contract ABI (Cairo 0 or Cairo 1) to the facts classification
 * needs. Stored per class hash, so size is bounded and reusable.
 */
export function summarizeAbi(abi, { classHash = null } = {}) {
  if (!Array.isArray(abi))
    throw new ApiError("INVALID_ABI", "Contract ABI must be an array", 400);
  const functions = [];
  const events = [];
  for (const item of abi) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function" && typeof item.name === "string")
      functions.push(item.name);
    else if (item.type === "event" && typeof item.name === "string") {
      const short = item.name.split("::").pop().split("#").pop();
      if (item.kind === "enum") {
        // Nested/enum events are decoded by their variants; layouts stay unknown.
        events.push({ name: short, keys: null, data: null, enum: true });
        continue;
      }
      if (Array.isArray(item.members)) {
        events.push({
          name: short,
          keys: item.members.filter((m) => m?.kind === "key").length,
          data: item.members.filter((m) => m?.kind === "data").length,
        });
      } else if (Array.isArray(item.inputs)) {
        // Cairo 0: the selector is the only key; all inputs ride in data.
        events.push({ name: short, keys: 1, data: item.inputs.length });
      } else events.push({ name: short, keys: null, data: null });
    }
  }
  return {
    classHash,
    functions: [...new Set(functions)].sort(),
    events,
    fetchedAt: Date.now(),
  };
}

const has = (summary, names) =>
  names.some((name) => summary?.functions?.includes(name));

/** Canonical method -> actual ABI name(s) present, proving alias awareness. */
export function methodAliases(summary, table = ERC721_ALIASES) {
  const aliases = {};
  for (const [canonical, options] of Object.entries(table)) {
    const found = options.filter((name) =>
      summary?.functions?.includes(name),
    );
    if (found.length) aliases[canonical] = found;
  }
  return aliases;
}

/**
 * Pure classification decision from interface probes + effective ABI summary.
 * probes: [{name, interfaceId, supported:boolean, error?:string}]
 * Returns {standard, method, state, classification}.
 * A Transfer event alone is never sufficient: fungible ABIs are marked ERC20
 * inside the evidence and the record stays non-indexable (standard null).
 */
export function classifyFromEvidence({
  summary,
  probes = [],
  implementation = null,
  proxyUncertainty = null,
  classHash = null,
  evidenceBlock = null,
}) {
  const probe = (name) => probes.find((p) => p.name === name)?.supported === true;
  const evidence = [];
  if (!probes.length)
    evidence.push({
      kind: "no_introspection",
      note: "ABI does not declare supports_interface; only ABI markers applied",
    });
  for (const p of probes)
    evidence.push({
      kind: p.error ? "probe_error" : "supports_interface",
      interface: p.name,
      interfaceId: p.interfaceId,
      supported: p.supported,
      ...(p.error ? { error: p.error } : {}),
    });

  let standard = null,
    label = null,
    method = "none",
    uncertainty = proxyUncertainty;
  const effective = implementation?.summary ?? summary;

  if (probe("erc721")) {
    standard = "ERC721";
    method = "src5";
  } else if (probe("erc1155")) {
    standard = "ERC1155";
    method = "src5";
  } else if (probe("erc721Legacy")) {
    standard = "ERC721";
    method = "erc165_legacy";
  } else if (has(effective, ["owner_of"]) && has(effective, ERC721_FUNCTIONS.slice(1))) {
    standard = "ERC721";
    method = implementation ? "proxy_abi" : "abi";
    uncertainty ??= "abi_only";
    evidence.push({ kind: "abi_markers", markers: ERC721_FUNCTIONS.filter((f) => has(effective, [f])) });
  } else if (
    has(effective, ERC1155_FUNCTIONS) &&
    has(effective, ["balance_of_batch", "safe_batch_transfer_from"])
  ) {
    standard = "ERC1155";
    method = implementation ? "proxy_abi" : "abi";
    uncertainty ??= "abi_only";
    evidence.push({ kind: "abi_markers", markers: ERC1155_FUNCTIONS.filter((f) => has(effective, [f])) });
  } else if (
    has(effective, ["decimals", "transfer"]) &&
    !has(effective, ["owner_of"])
  ) {
    // Fungible: recorded as evidence, never as an NFT standard.
    method = implementation ? "proxy_abi" : "abi";
    label = "ERC20";
    evidence.push({
      kind: "fungible_markers",
      markers: ERC20_FUNCTIONS.filter((f) => has(effective, [f])),
    });
    uncertainty ??= "fungible";
  } else {
    method = summary?.functions?.length ? "abi" : "none";
    uncertainty ??= summary?.functions?.length
      ? "unknown_implementation"
      : "abi_unavailable";
    evidence.push({
      kind: "unmatched",
      functionsSample: (summary?.functions ?? []).slice(0, 12),
    });
  }

  if (probe("erc2981")) evidence.push({ kind: "royalties", interface: "erc2981" });

  const eventLayouts = {};
  for (const event of effective?.events ?? []) {
    if (LAYOUT_EVENTS.includes(event.name))
      eventLayouts[event.name] = { keys: event.keys, data: event.data };
  }

  const classification = {
    standard: standard ?? label,
    method,
    classHash: classHash ?? summary?.classHash ?? null,
    implementation: implementation?.address ?? null,
    uncertainty,
    evidence,
    aliases: standard === "ERC721" || standard === "ERC1155" ? methodAliases(effective) : {},
    eventLayouts,
    evidenceBlock,
  };
  if (implementation)
    classification.implementationClassHash =
      implementation.classHash ?? null;
  return { standard, method, classification };
}

/** Record fields produced by a classification result. */
export function classificationPatch(record, { standard, classification, state: forced }) {
  const previous = record ?? {};
  const keepStates = ["syncing", "indexed"];
  const state =
    forced ??
    (standard
      ? keepStates.includes(previous.state)
        ? previous.state
        : "candidate"
      : "unsupported");
  return {
    standard: standard ?? null,
    classification: trimEvidence(classification),
    state,
  };
}

const trimEvidence = (classification) => {
  const copy = { ...classification };
  if (JSON.stringify(copy).length <= 32_000) return copy;
  copy.evidence = copy.evidence.slice(0, 8);
  copy.truncated = true;
  if (JSON.stringify(copy).length > 32_600)
    throw new ApiError(
      "CLASSIFICATION_TOO_LARGE",
      "Classification evidence exceeds the record budget",
      400,
    );
  return copy;
};

/**
 * True when a record needs a (fresh) classification pass: never classified,
 * exhausted by a bounded retry, or pinned to a class that no longer matches
 * the active class interval (upgrade after classification).
 */
export function needsClassification(record, atBlock, { maxAttempts = 3 } = {}) {
  const classification = record?.classification ?? null;
  if (!classification) return true;
  if (classification.method === "probe_failed")
    return (classification.attempts ?? 1) < maxAttempts;
  const active = activeClassInterval(record, atBlock);
  if (
    active?.classHash &&
    classification.classHash &&
    BigInt(active.classHash) !== BigInt(classification.classHash)
  )
    return true;
  return false;
}

/** Failure result for one candidate; never aborts the batch. */
export function failedClassification(record, error, atBlock) {
  const previous = record?.classification ?? null;
  return {
    standard: record?.standard ?? null,
    method: "probe_failed",
    state: previous?.method === "probe_failed" ? record.state : record?.state ?? "unknown",
    classification: {
      standard: null,
      method: "probe_failed",
      classHash: previous?.classHash ?? activeClassInterval(record, atBlock)?.classHash ?? null,
      uncertainty: "probe_failed",
      evidence: [
        ...(previous?.method === "probe_failed" ? previous.evidence ?? [] : []),
        {
          kind: "probe_error",
          code: error?.code ?? "UNKNOWN",
          message: String(error?.message ?? error).slice(0, 300),
        },
      ],
      attempts: ((previous?.attempts ?? 0) + 1),
      evidenceBlock: atBlock,
    },
  };
}
