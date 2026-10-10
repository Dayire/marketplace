import { readFileSync } from "node:fs";
import { selectorFromName } from "./starknet-selector.mjs";
import { address, uint, fromU256, orderKey, ApiError } from "./domain.mjs";
export const SELECTORS = JSON.parse(
  readFileSync(
    new URL("../../../config/marketplace/selectors.json", import.meta.url),
    "utf8",
  ),
);
/** Decoder capability, versioned separately from class versions (#112). */
export const DECODER_CAPABILITY = "nft-events.v2";
export const UNKNOWN_COLLECTION_EVENT = "UNKNOWN_COLLECTION_EVENT";
const INTROSPECTION = JSON.parse(
  readFileSync(
    new URL("../../../config/marketplace/introspection.json", import.meta.url),
    "utf8",
  ),
);
const selectorNames = new Map(
  Object.entries(SELECTORS).map(([k, v]) => [BigInt(v).toString(), k]),
);
/** Cairo 1 contracts can wrap NFT events inside an event enum (#112). */
const eventEnumWrappers = new Map(
  Object.entries(INTROSPECTION.eventEnumWrappers ?? {}).map(([selector, name]) => [
    BigInt(selector).toString(),
    name,
  ]),
);
const NFT_EVENT_NAMES = new Set([
  "Transfer",
  "TransferSingle",
  "BatchTransfer",
  "TransferBatch",
  "Approval",
  "ApprovalForAll",
  "MetadataUpdate",
  "BatchMetadataUpdate",
  "URI",
]);
// These events do not change NFT ownership, quantity, approval or metadata.
// A name is insufficient: resolution below also requires the active class ABI.
const UNMODELED_EVENTS = new Set([
  "Upgraded", "AdminChanged", "OwnershipTransferred", "OwnershipTransferStarted",
  "RoleGranted", "RoleRevoked", "RoleAdminChanged", "Paused", "Unpaused",
  "DelegateChanged", "DelegateVotesChanged",
]);
function reader(values) {
  let i = 0;
  const next = () => {
    if (i >= values.length)
      throw new ApiError("INVALID_EVENT", "Truncated event.");
    return values[i++];
  };
  return {
    felt: () => uint(next(), 252),
    addr: () => address(next()),
    int: (bits = 64) => uint(next(), bits),
    u256: () => fromU256(next(), next()),
    bool: () => {
      const n = uint(next(), 1);
      return n === "1";
    },
    end: () => {
      if (i !== values.length)
        throw new ApiError("INVALID_EVENT", "Unexpected event fields.");
    },
  };
}
export function readTerms(data) {
  const r = reader(data);
  const kind = ["unknown", "listing", "token_offer", "collection_offer"][
    Number(r.int(8))
  ];
  if (!kind || kind === "unknown")
    throw new ApiError("UNKNOWN_KIND", "Unknown order type.");
  const collection = r.addr(),
    rawToken = r.u256(),
    currency = r.addr(),
    buyerDebit = r.u256(),
    expiry = r.int(),
    royaltyCap = r.u256(),
    royaltyRecipient = r.addr(),
    royaltyAmount = r.u256(),
    feeBps = Number(r.int(16));
  if (feeBps > 500) throw new ApiError("INVALID_EVENT", "Fee exceeds cap.");
  r.end();
  return {
    kind,
    collection,
    tokenId: kind === "collection_offer" ? null : rawToken,
    currency,
    buyerDebit,
    expiry,
    royaltyCap,
    royaltyRecipient,
    royaltyAmount,
    feeBps,
  };
}
export function decodeEvent(raw, config, summary = null) {
  if (!Array.isArray(raw.keys) || !raw.keys.length || !Array.isArray(raw.data))
    throw new ApiError("INVALID_EVENT", "Invalid event envelope.");
  const source = address(raw.from_address),
    name = selectorNames.get(BigInt(raw.keys[0]).toString());
  const market = config.marketplace && source === address(config.marketplace);
  if (market) {
    let e;
    if (["OrderCreated", "OrderCancelled", "OrderFilled"].includes(name)) {
      if (raw.keys.length !== 3)
        throw new ApiError("INVALID_EVENT", "Order event keys.");
      const maker = address(raw.keys[1]),
        nonce = uint(raw.keys[2], 64),
        key = orderKey(config.chain, config.marketplace, maker, nonce);
      if (name === "OrderCreated")
        e = {
          type: "order_created",
          key,
          maker,
          nonce,
          ...readTerms(raw.data),
        };
      else if (name === "OrderCancelled") {
        if (raw.data.length) throw new ApiError("INVALID_EVENT", "Cancel data");
        e = { type: "order_cancelled", key, maker, nonce };
      } else {
        const r = reader(raw.data);
        e = {
          type: "order_filled",
          key,
          maker,
          nonce,
          buyer: r.addr(),
          seller: r.addr(),
          collection: r.addr(),
          tokenId: r.u256(),
          currency: r.addr(),
          buyerDebit: r.u256(),
          sellerProceeds: r.u256(),
          protocolFee: r.u256(),
          feeRecipient: r.addr(),
          royaltyAmount: r.u256(),
          royaltyRecipient: r.addr(),
        };
        r.end();
      }
    } else {
      const r = reader(raw.data);
      if (name === "MarketplaceInitialized")
        e = {
          type: "initialized",
          version: Number(r.int(32)),
          admin: r.addr(),
          feeBps: Number(r.int(16)),
          feeRecipient: r.addr(),
          paused: false,
          marketplace: source,
        };
      else if (name === "FeePolicyChanged") {
        const feeBps = Number(r.int(16)),
          feeRecipient = r.addr();
        if (raw.keys.length !== 1 || feeBps > 500 || BigInt(feeRecipient) === 0n)
          throw new ApiError("INVALID_EVENT", "Invalid fee policy.");
        e = { type: "fee_policy_changed", feeBps, feeRecipient };
      } else if (name === "TradingChanged")
        e = { type: "trading_changed", paused: r.bool() };
      else if (name === "CollectionPolicyChanged") {
        if (raw.keys.length !== 2)
          throw new ApiError("INVALID_EVENT", "Policy key");
        e = {
          type: "collection_policy",
          address: address(raw.keys[1]),
          enabled: r.bool(),
          royalties: r.bool(),
        };
      } else if (name === "CurrencyPolicyChanged") {
        if (raw.keys.length !== 2)
          throw new ApiError("INVALID_EVENT", "Policy key");
        e = {
          type: "currency_policy",
          address: address(raw.keys[1]),
          enabled: r.bool(),
        };
      } else if (name === "AdminProposed")
        e = { type: "admin_proposed", admin: r.addr() };
      else if (name === "AdminTransferred")
        e = { type: "admin_transferred", previous: r.addr(), admin: r.addr() };
      else
        throw new ApiError(
          "UNKNOWN_MARKET_EVENT",
          `Unknown marketplace selector ${raw.keys[0]}`,
        );
      r.end();
    }
    return e;
  }
  if (!config.collections.some((c) => address(c.address) === source))
    return null;
  const resolved = resolveCollectionEvent(raw.keys, summary);
  if (resolved.unmodeled) return null;
  if (!resolved.name) {
    // Without ABI context the legacy "not modeled" answer stays a null drop;
    // with context an unsupported selector is refused so the scanner can
    // quarantine the collection instead of inventing state (#112).
    if (!summary) return null;
    throw new ApiError(
      UNKNOWN_COLLECTION_EVENT,
      `Unsupported collection event selector 0x${BigInt(resolved.unsupported).toString(16)}`,
      409,
      { collection: source, selector: resolved.unsupported },
    );
  }
  const members = membersFor(summary, resolved.name);
  if (summary && (!declaresEvent(summary, resolved.name) || (summary.requireAbiLayout && !members)))
    throw new ApiError(
      UNKNOWN_COLLECTION_EVENT,
      `Collection ABI does not prove the ${resolved.name} event layout.`,
      409,
      { collection: source, classHash: summary.classHash ?? null, event: resolved.name },
    );
  const event = resolved.name === "URI"
    ? decodeCairo0Uri(raw, source, resolved, members)
    : members
    ? decodeWithMembers(raw, source, resolved, members)
    : decodeFlattened(raw, source, resolved);
  return { ...event, raw, decoderVersion: DECODER_CAPABILITY };
}

/** Flat selector or configured enum wrapper -> canonical NFT event name. */
function resolveCollectionEvent(keys, summary) {
  const key0 = BigInt(keys[0]).toString();
  const flat = selectorNames.get(key0);
  if (flat && NFT_EVENT_NAMES.has(flat))
    return { name: flat, consumedKeys: 1 };
  const abiName = (key) => summary?.events?.find((event) =>
    !event.enum && (NFT_EVENT_NAMES.has(event.name) || UNMODELED_EVENTS.has(event.name)) &&
    BigInt(selectorFromName(event.name)).toString() === key)?.name;
  const known = abiName(key0);
  if (known) return { name: known, consumedKeys: 1, unmodeled: UNMODELED_EVENTS.has(known) };
  const wrapper = eventEnumWrappers.get(key0);
  if (wrapper) {
    if (keys.length < 2)
      throw new ApiError("INVALID_EVENT", "Truncated enum event.");
    const variant = selectorNames.get(BigInt(keys[1]).toString()) ?? abiName(BigInt(keys[1]).toString());
    if (variant && NFT_EVENT_NAMES.has(variant))
      return { name: variant, consumedKeys: 2, enumName: wrapper };
    if (variant && UNMODELED_EVENTS.has(variant) && declaresEvent(summary, variant))
      return { name: variant, consumedKeys: 2, enumName: wrapper, unmodeled: true };
    return { unsupported: BigInt(keys[1]).toString() };
  }
  return { unsupported: BigInt(keys[0]).toString() };
}

const membersFor = (summary, name) =>
  summary?.events?.find((e) => e.name === name && Array.isArray(e.members))
    ?.members ?? null;
const declaresEvent = (summary, name) =>
  summary.events?.some((event) =>
    event.name === name ||
    (event.enum && event.variants?.some((variant) => variant.name === name)),
  ) ?? false;

const normalizeMember = (name) => String(name).toLowerCase().replaceAll("_", "");
const MEMBER_FIELDS = {
  from: "from",
  to: "to",
  tokenid: "tokenId",
  id: "tokenId",
  value: "value",
  owner: "owner",
  spender: "spender",
  operator: "operator",
  approved: "approved",
  fromtokenid: "fromTokenId",
  totokenid: "toTokenId",
  ids: "ids",
  values: "values",
  amounts: "values",
};
const DECIMAL_FIELDS = new Set([
  "tokenId",
  "fromTokenId",
  "toTokenId",
  "value",
  "ids",
  "values",
]);
const ADDRESS_FIELDS = new Set(["from", "to", "owner", "spender", "operator"]);

/** Deployed Briq/OZ Cairo 0 URI(value_len, value*, Uint256 id) notification. */
function decodeCairo0Uri(raw, source, resolved, members) {
  if (!members || members.length !== 3 || members.some((member) => member.kind !== "data") ||
    normalizeMember(members[0].name) !== "valuelen" ||
    normalizeMember(members[1].name) !== "value" || !/^felt\*$/.test(members[1].type) ||
    !["id", "tokenid"].includes(normalizeMember(members[2].name)) ||
    !/u256|uint256/i.test(members[2].type))
    throw new ApiError(UNKNOWN_COLLECTION_EVENT, "Unsupported URI event layout.", 409);
  const length = BigInt(uint(raw.data[0], 64));
  if (length > 4096n || raw.keys.length !== resolved.consumedKeys || raw.data.length !== Number(length) + 3)
    throw new ApiError("INVALID_EVENT", "Malformed or oversized URI notification.");
  for (const felt of raw.data.slice(1, Number(length) + 1)) uint(felt, 252);
  return { type: "metadata_update", collection: source, tokenId: fromU256(...raw.data.slice(-2)), decoder: "cairo0-uri.v1" };
}

/**
 * ABI-member-driven layout: key members come from keys, data members from
 * data, in declaration order. Flattening cannot represent interleaved
 * key/data layouts, so this adapter owns them (#112).
 */
function decodeWithMembers(raw, source, resolved, members) {
  const streams = {
    key: [...raw.keys.slice(resolved.consumedKeys)],
    data: [...raw.data],
  };
  const values = {};
  for (const member of members) {
    const normalized = normalizeMember(member.name);
    const field = resolved.name === "Approval" && normalized === "approved"
      ? "spender"
      : MEMBER_FIELDS[normalized];
    if (!field || Object.hasOwn(values, field))
      throw new ApiError("INVALID_EVENT", `Unsupported or duplicate event field ${member.name}.`);
    const stream = streams[member.kind === "key" ? "key" : "data"];
    const take = (count) => {
      if (stream.length < count)
        throw new ApiError("INVALID_EVENT", "Truncated event fields.");
      return stream.splice(0, count);
    };
    const type = String(member.type ?? "");
    let value;
    if (/array/i.test(type)) {
      // Dynamic arrays are length-prefixed; u256 arrays serialize as pairs.
      const length = uint(take(1)[0], 252);
      if (length > 4096)
        throw new ApiError("INVALID_EVENT", "Event array exceeds bound.");
      const items = [];
      if (/u256|uint256/i.test(type)) {
        for (let i = 0; i < length; i++) {
          const [low, high] = take(2);
          items.push(fromU256(low, high));
        }
      } else
        for (let i = 0; i < length; i++) items.push(uint(take(1)[0], 252));
      value = items;
    } else if (/u256|uint256/i.test(type)) {
      const [low, high] = take(2);
      value = fromU256(low, high);
    } else if (/contractaddress|::address/i.test(type) || ADDRESS_FIELDS.has(field)) value = address(take(1)[0]);
    else if (/bool/i.test(type) || (resolved.name === "ApprovalForAll" && field === "approved")) value = uint(take(1)[0], 1) === "1";
    else value = uint(take(1)[0], 252);
    if (DECIMAL_FIELDS.has(field) && typeof value === "string" && value.startsWith("0x"))
      value = BigInt(value).toString();
    values[field] = value;
  }
  if (streams.key.length || streams.data.length)
    throw new ApiError("INVALID_EVENT", "Unexpected event fields.");
  const require = (field) => {
    if (values[field] === undefined)
      throw new ApiError("INVALID_EVENT", `Missing event field ${field}.`);
  };
  let event;
  if (resolved.name === "Transfer") {
    require("from");
    require("to");
    require("tokenId");
    event =
      values.value !== undefined
        ? {
            type: "erc1155_transfer",
            collection: source,
            from: values.from,
            to: values.to,
            tokenId: values.tokenId,
            value: values.value,
          }
        : {
            type: "transfer",
            collection: source,
            from: values.from,
            to: values.to,
            tokenId: values.tokenId,
          };
  } else if (resolved.name === "TransferSingle") {
    require("from");
    require("to");
    require("tokenId");
    require("value");
    event = {
      type: "erc1155_transfer",
      collection: source,
      from: values.from,
      to: values.to,
      tokenId: values.tokenId,
      value: values.value,
    };
  } else if (
    resolved.name === "BatchTransfer" ||
    resolved.name === "TransferBatch"
  ) {
    require("from");
    require("to");
    require("ids");
    require("values");
    if (
      !Array.isArray(values.ids) ||
      !Array.isArray(values.values) ||
      values.ids.length !== values.values.length
    )
      throw new ApiError("INVALID_EVENT", "Mismatched batch transfer fields.");
    event = {
      type: "erc1155_batch_transfer",
      collection: source,
      from: values.from,
      to: values.to,
      ids: values.ids,
      values: values.values,
    };
  } else if (resolved.name === "Approval") {
    require("owner");
    require("spender");
    require("tokenId");
    event = {
      type: "approval",
      collection: source,
      owner: values.owner,
      spender: values.spender,
      tokenId: values.tokenId,
    };
  } else if (resolved.name === "ApprovalForAll") {
    require("owner");
    require("operator");
    require("approved");
    event = {
      type: "operator_approval",
      collection: source,
      owner: values.owner,
      operator: values.operator,
      approved: values.approved,
    };
  } else if (resolved.name === "MetadataUpdate") {
    require("tokenId");
    event = { type: "metadata_update", collection: source, tokenId: values.tokenId };
  } else {
    require("fromTokenId");
    require("toTokenId");
    event = {
      type: "metadata_update",
      collection: source,
      fromTokenId: values.fromTokenId,
      toTokenId: values.toTokenId,
    };
  }
  return { ...event, decoder: "nft-members.v2" };
}

/** Legacy fixed-order adapter: key remainder first, then data. */
function decodeFlattened(raw, source, resolved) {
  const r = reader([
    ...raw.keys.slice(resolved.consumedKeys),
    ...raw.data,
  ]);
  let e;
  if (resolved.name === "Transfer")
    e = {
      type: "transfer",
      collection: source,
      from: r.addr(),
      to: r.addr(),
      tokenId: r.u256(),
    };
  else if (resolved.name === "TransferSingle")
    e = {
      type: "erc1155_transfer",
      collection: source,
      from: r.addr(),
      to: r.addr(),
      tokenId: r.u256(),
      value: r.u256(),
    };
  else if (
    resolved.name === "BatchTransfer" ||
    resolved.name === "TransferBatch"
  ) {
    const from = r.addr(),
      to = r.addr();
    const count = r.int(64),
      ids = [];
    for (let i = 0; i < count; i++) ids.push(r.u256());
    const amountsCount = r.int(64),
      values = [];
    if (amountsCount !== count)
      throw new ApiError("INVALID_EVENT", "Mismatched batch transfer fields.");
    for (let i = 0; i < count; i++) values.push(r.u256());
    e = {
      type: "erc1155_batch_transfer",
      collection: source,
      from,
      to,
      ids,
      values,
    };
  } else if (resolved.name === "Approval")
    e = {
      type: "approval",
      collection: source,
      owner: r.addr(),
      spender: r.addr(),
      tokenId: r.u256(),
    };
  else if (resolved.name === "ApprovalForAll")
    e = {
      type: "operator_approval",
      collection: source,
      owner: r.addr(),
      operator: r.addr(),
      approved: r.bool(),
    };
  else if (resolved.name === "MetadataUpdate")
    e = { type: "metadata_update", collection: source, tokenId: r.u256() };
  else if (resolved.name === "BatchMetadataUpdate")
    e = {
      type: "metadata_update",
      collection: source,
      fromTokenId: r.u256(),
      toTokenId: r.u256(),
    };
  else return null;
  r.end();
  return {
    ...e,
    decoder: resolved.enumName ? "nft-enum.v2" : "nft-flat.v2",
  };
}
