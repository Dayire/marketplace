import { readFileSync } from "node:fs";
import { ApiError } from "./domain.mjs";
import { activeClassInterval } from "./discovery.mjs";
import { DECODER_CAPABILITY } from "./decode.mjs";

/** Interface ids and entrypoint selectors for contract classification (#111). */
export const INTROSPECTION = JSON.parse(
  readFileSync(
    new URL("../../../config/marketplace/introspection.json", import.meta.url),
    "utf8",
  ),
);
export const ABI_SUMMARY_VERSION = 3;

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
  balance_of_batch: ["balance_of_batch", "balanceOfBatch"],
  owner_of: ["owner_of", "ownerOf"],
  token_uri: ["token_uri", "tokenURI"],
  transfer_from: ["transfer_from", "transferFrom"],
  safe_transfer_from: ["safe_transfer_from", "safeTransferFrom"],
  approve: ["approve"],
  get_approved: ["get_approved", "getApproved"],
  is_approved_for_all: ["is_approved_for_all", "isApprovedForAll"],
  safe_batch_transfer_from: ["safe_batch_transfer_from", "safeBatchTransferFrom"],
  total_supply: ["total_supply", "totalSupply"],
  token_by_index: ["token_by_index", "tokenByIndex"],
  token_of_owner_by_index: ["token_of_owner_by_index", "tokenOfOwnerByIndex"],
  supports_interface: ["supports_interface", "supportsInterface"],
  uri: ["uri", "URI"],
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
  "TransferSingle",
  "TransferBatch",
  "BatchTransfer",
];

/**
 * Reduce a contract ABI (Cairo 0 or Cairo 1) to the facts classification
 * needs. Stored per class hash, so size is bounded and reusable.
 */
export function summarizeAbi(abi, { classHash = null } = {}) {
  if (typeof abi === "string") {
    try {
      abi = JSON.parse(abi);
    } catch {
      throw new ApiError("INVALID_ABI", "Contract ABI is not valid JSON", 400);
    }
  }
  if (!Array.isArray(abi))
    throw new ApiError("INVALID_ABI", "Contract ABI must be an array", 400);
  const functions = [];
  const zeroArgumentFunctions = [];
  const functionInputs = {};
  const functionOutputs = {};
  const events = [];
  const walk = (items, depth = 0) => {
    if (depth > 16 || !Array.isArray(items))
      throw new ApiError("INVALID_ABI", "Contract ABI interfaces exceed supported nesting", 400);
    for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "interface") {
      if (Array.isArray(item.items)) walk(item.items, depth + 1);
      continue;
    }
    if (item.type === "function" && typeof item.name === "string") {
      functions.push(item.name);
      // A method name alone does not prove how a token ID is serialized.
      // Conflicting declarations stay unusable rather than picking one.
      for (const [target, fields] of [[functionInputs, item.inputs], [functionOutputs, item.outputs]]) {
        const signature = Array.isArray(fields) ? fields.map((field) => ({ name: field?.name ?? null, type: field?.type ?? null })) : null;
        if (!Object.hasOwn(target, item.name)) target[item.name] = signature;
        else if (JSON.stringify(target[item.name]) !== JSON.stringify(signature)) target[item.name] = null;
      }
      if (Array.isArray(item.inputs) && item.inputs.length === 0)
        zeroArgumentFunctions.push(item.name);
    }
    else if (item.type === "event" && typeof item.name === "string") {
      const short = item.name.split("::").pop().split("#").pop();
      if (item.kind === "enum") {
        // Enum wrappers are resolved by selector; variants carry the name.
        events.push({
          name: short,
          keys: null,
          data: null,
          enum: true,
          variants: (Array.isArray(item.variants) ? item.variants : []).map(
            (variant) => ({ name: variant?.name, kind: variant?.kind, type: variant?.type }),
          ),
        });
        continue;
      }
      if (Array.isArray(item.members)) {
        // Member kinds/types drive the decoder's key/data split (#112).
        events.push({
          name: short,
          keys: item.members.filter((m) => m?.kind === "key").length,
          data: item.members.filter((m) => m?.kind === "data").length,
          members: item.members.map((m) => ({
            name: m?.name,
            kind: m?.kind === "key" ? "key" : "data",
            type: m?.type ?? "felt",
          })),
        });
      } else if (Array.isArray(item.keys) && Array.isArray(item.data)) {
        // Deployed Cairo 0 ABIs name key/data streams separately. The event
        // selector is not included in this declaration's key field count.
        events.push({
          name: short,
          keys: item.keys.length,
          data: item.data.length,
          members: [
            ...item.keys.map((member) => ({ name: member?.name, kind: "key", type: member?.type ?? "felt" })),
            ...item.data.map((member) => ({ name: member?.name, kind: "data", type: member?.type ?? "felt" })),
          ],
        });
      } else if (Array.isArray(item.inputs)) {
        // Cairo 0: the selector is the only key; all inputs ride in data.
        events.push({
          name: short,
          keys: 1,
          data: item.inputs.length,
          members: item.inputs.map((input) => ({
            name: input?.name,
            kind: "data",
            type: input?.type ?? "felt",
          })),
        });
      } else events.push({ name: short, keys: null, data: null });
    }
    }
  };
  walk(abi);
  return {
    abiSummaryVersion: ABI_SUMMARY_VERSION,
    classHash,
    functions: [...new Set(functions)].sort(),
    zeroArgumentFunctions: [...new Set(zeroArgumentFunctions)].sort(),
    functionInputs,
    functionOutputs,
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
  proxyEvidence = [],
  classHash = null,
  evidenceBlock = null,
  evidenceBlockHash = null,
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
  evidence.push(...proxyEvidence);

  let standard = null,
    label = null,
    method = "none",
    uncertainty = proxyUncertainty;
  const effective = implementation?.summary ?? summary;
  const aliases = methodAliases(effective);
  const transfer = effective?.events?.find((event) => event.name === "Transfer");
  const transferFields = (transfer?.members ?? []).map((member) =>
    String(member.name).toLowerCase().replaceAll("_", ""),
  );
  const fungible =
    (has(effective, ["decimals"]) && has(effective, ["transfer"])) ||
    (transferFields.some((field) => ["value", "amount"].includes(field)) &&
      !transferFields.some((field) => ["tokenid", "id", "ids"].includes(field)));

  if (fungible) {
    // Positive introspection cannot turn explicit Transfer(value) semantics
    // into a token-ID layout. Retain contradictory claims in the evidence.
    method = implementation ? "proxy_abi" : "abi";
    label = "ERC20";
    uncertainty = "fungible";
    evidence.push({ kind: "fungible_markers", markers: ERC20_FUNCTIONS.filter((f) => has(effective, [f])) });
  } else if (probe("erc721")) {
    standard = "ERC721";
    method = "src5";
  } else if (probe("erc1155")) {
    standard = "ERC1155";
    method = "src5";
  } else if (probe("erc721Legacy")) {
    standard = "ERC721";
    method = "erc165_legacy";
  } else if (aliases.owner_of && (aliases.transfer_from || aliases.safe_transfer_from)) {
    standard = "ERC721";
    method = implementation ? "proxy_abi" : "abi";
    uncertainty ??= "abi_only";
    evidence.push({ kind: "abi_markers", markers: ERC721_FUNCTIONS.filter((f) => aliases[f]) });
  } else if (
    aliases.balance_of_batch && aliases.safe_batch_transfer_from
  ) {
    standard = "ERC1155";
    method = implementation ? "proxy_abi" : "abi";
    uncertainty ??= "abi_only";
    evidence.push({ kind: "abi_markers", markers: ERC1155_FUNCTIONS.filter((f) => has(effective, [f])) });
  } else if (
    has(effective, ["decimals", "transfer"]) &&
    !aliases.owner_of
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
    aliases: standard === "ERC721" || standard === "ERC1155" ? aliases : {},
    eventLayouts,
    evidenceBlock,
    evidenceBlockHash,
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
    // Decoder capability is versioned on the record, independent of the
    // class hash intervals in classHistory (#112).
    ...(standard ? { decoderVersion: DECODER_CAPABILITY } : {}),
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
  if (classification.implementationClassHash && classification.evidenceBlock !== atBlock) return true;
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
