import { address, uint, ApiError } from "./domain.mjs";
import { collectionKey } from "./collection-catalog.mjs";

/** The discovery walk is its own chain-wide source; address 0 cannot be a contract. */
export const DISCOVERY_ADDRESS = address("0x0");
export const discoveryKey = (chainId) => collectionKey(chainId, DISCOVERY_ADDRESS);
export const MAX_DISCOVERY_SPAN = 2000;

const invalid = (message) => {
  throw new ApiError("INVALID_STATE_UPDATE", message);
};
const hex = (value, label) => {
  try {
    return "0x" + BigInt(uint(value, 252)).toString(16);
  } catch {
    return invalid(label);
  }
};
const contract = (value, label) => {
  try {
    return address(value);
  } catch {
    return invalid(label);
  }
};
const position = (event) => ({
  block: event.block,
  hash: event.hash,
  transactionIndex: null,
  eventIndex: null,
});
const samePosition = (a, b) =>
  a != null && b != null && a.block === b.block && BigInt(a.hash) === BigInt(b.hash);

/** Strict parse of an accepted block's state update (spec v0.10.4 STATE_UPDATE).
 * Pre-confirmed updates carry no block hash and are never canonical evidence.
 */
export function normalizeStateUpdate(blockNumber, update) {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0)
    invalid("State update block must be a non-negative integer.");
  if (!update || typeof update !== "object" || Array.isArray(update))
    invalid("State update must be an object.");
  if (update.block_hash == null)
    invalid("State update has no block hash; pre-confirmed blocks are not evidence.");
  const diff = update.state_diff;
  if (!diff || typeof diff !== "object" || Array.isArray(diff))
    invalid("State update is missing its state diff.");
  for (const key of ["deployed_contracts", "replaced_classes"])
    if (diff[key] != null && !Array.isArray(diff[key])) invalid(`${key} must be an array.`);
  const hash = hex(update.block_hash, "Invalid state update block hash.");
  const deployments = new Map();
  for (const item of diff.deployed_contracts ?? []) {
    if (!item || typeof item !== "object") invalid("Invalid deployed contract item.");
    const value = contract(
      item.address ?? item.contract_address,
      "Invalid deployed contract address.",
    );
    const classHash = hex(item.class_hash, "Invalid deployed class hash.");
    if (deployments.has(value) && deployments.get(value) !== classHash)
      invalid("Conflicting classes behind one deployment in a single block.");
    if (!deployments.has(value)) deployments.set(value, classHash);
  }
  const replacements = new Map();
  for (const item of diff.replaced_classes ?? []) {
    if (!item || typeof item !== "object") invalid("Invalid replaced class item.");
    const value = contract(
      item.contract_address ?? item.address,
      "Invalid replaced class address.",
    );
    const classHash = hex(item.class_hash, "Invalid replaced class hash.");
    if (replacements.has(value) && replacements.get(value) !== classHash)
      invalid("Conflicting class replacements in a single block.");
    if (!replacements.has(value)) replacements.set(value, classHash);
  }
  return {
    block: blockNumber,
    hash,
    deployments: [...deployments].map(([value, classHash]) => ({
      address: value,
      classHash,
    })),
    replacements: [...replacements].map(([value, classHash]) => ({
      address: value,
      classHash,
    })),
  };
}

/** Bounded, resumable planning: never more than span blocks, never past head/stopAt. */
export function planDiscoveryRange({
  checkpoint = null,
  earliest = 0,
  head,
  span,
  stopAt = null,
}) {
  if (!Number.isInteger(span) || span < 1 || span > MAX_DISCOVERY_SPAN)
    throw new ApiError(
      "INVALID_WINDOW",
      `Discovery span must be an integer from 1 to ${MAX_DISCOVERY_SPAN}.`,
    );
  for (const [value, label] of [
    [earliest, "earliest block"],
    [head, "head block"],
    [stopAt, "stop block"],
  ])
    if (value != null && (!Number.isSafeInteger(value) || value < 0))
      throw new ApiError("INVALID_WINDOW", `Invalid ${label}.`);
  if (checkpoint != null && (!Number.isSafeInteger(checkpoint) || checkpoint < 0))
    throw new ApiError("INVALID_WINDOW", "Invalid discovery checkpoint.");
  const from = checkpoint == null ? earliest : checkpoint + 1,
    limit = Math.min(head, stopAt ?? head);
  if (from > limit) return null;
  return { from, to: Math.min(from + span - 1, limit) };
}

/** Merge ordered class evidence ({block, hash, kind: deploy|replace, classHash})
 * for ONE address into its catalog facts. Idempotent on duplicate input; a class
 * change closes the open interval, opens the next and invalidates classification.
 */
export function mergeDiscovery(previous, events) {
  if (!Array.isArray(events) || !events.length)
    throw new ApiError("INVALID_STATE_UPDATE", "Class evidence is required.");
  let state = previous?.state ?? "candidate",
    classification = previous?.classification ?? null,
    deployment = previous?.deployment ?? null;
  const classHistory = (previous?.classHistory ?? []).map((interval) => ({
    ...interval,
  }));
  const invalidate = () => {
    classification = null;
    if (state !== "failed") state = "candidate";
  };
  for (const event of [...events].sort(
    (a, b) => a.block - b.block || (a.kind === "deploy" ? -1 : 1),
  )) {
    const openIndex = classHistory.findIndex((interval) => interval.to == null),
      open = openIndex === -1 ? null : classHistory[openIndex];
    if (event.kind === "deploy") {
      if (!deployment) deployment = position(event);
      else if (!samePosition(deployment, position(event))) {
        if (!open || open.classHash !== event.classHash)
          throw new ApiError(
            "DISCOVERY_CONFLICT",
            "A different class behind a deploy must be a replacement.",
            409,
          );
        // Duplicate deployment evidence with the reviewed class: first position wins.
      }
      if (!open) {
        classHistory.push({
          classHash: event.classHash,
          from: position(event),
          to: null,
        });
      } else if (open.classHash !== event.classHash)
        throw new ApiError(
          "DISCOVERY_CONFLICT",
          "Conflicting class evidence for one deployment.",
          409,
        );
    } else {
      if (!open) {
        if (classHistory.length) invalidate();
        classHistory.push({
          classHash: event.classHash,
          from: position(event),
          to: null,
        });
      } else if (open.classHash !== event.classHash) {
        classHistory[openIndex] = { ...open, to: position(event) };
        classHistory.push({
          classHash: event.classHash,
          from: position(event),
          to: null,
        });
        invalidate();
      }
    }
  }
  return {
    state,
    standard: previous?.standard ?? null,
    deployment,
    classHistory,
    classification,
    decoderVersion: previous?.decoderVersion ?? null,
  };
}

/** Evidence-backed fields for an event emitter with no class/deployment proof yet. */
export function emitterCandidateFields() {
  return {
    state: "candidate",
    standard: null,
    deployment: null,
    classHistory: [],
    classification: null,
    decoderVersion: null,
  };
}

/** The interval in force at a block; the interval opening at the change block wins. */
export function activeClassInterval(record, block) {
  const valid = (record?.classHistory ?? []).filter(
    (interval) =>
      interval.from.block <= block && (interval.to == null || interval.to.block > block),
  );
  return valid.at(-1) ?? null;
}
