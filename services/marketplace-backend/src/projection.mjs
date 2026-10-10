import { address, uint, ApiError } from "./domain.mjs";

/** Pure event reducer; both storage engines enforce atomicity around these writes. */
export function projectEvent(e, p, get, put) {
  const height = p.blockNumber;
  if (e.type === "transfer") {
    const id = `${address(e.collection)}:${uint(e.tokenId)}`,
      old = get("token", id);
    put(
      "token",
      id,
      {
        ...old,
        id,
        collection: address(e.collection),
        tokenId: uint(e.tokenId),
        owner: address(e.to),
        burned: BigInt(e.to) === 0n,
        attributes: old?.attributes ?? [],
        metadata: old?.metadata ?? {},
        firstSeenBlock: old?.firstSeenBlock ?? height,
        updatedAt: p,
      },
      height,
    );
    put("approval", id, { spender: address("0x0") }, height);
  } else if (e.type === "approval") {
    put(
      "approval",
      `${address(e.collection)}:${uint(e.tokenId)}`,
      { spender: address(e.spender) },
      height,
    );
  } else if (e.type === "operator_approval") {
    put(
      "operator",
      `${address(e.collection)}:${address(e.owner)}:${address(e.operator)}`,
      { approved: e.approved },
      height,
    );
  } else if (e.type === "order_created") {
    if (get("order", e.key))
      throw new ApiError("DUPLICATE_ORDER", "Maker nonce reused.");
    put(
      "order",
      e.key,
      { ...e, id: e.key, state: "open", createdAt: p, updatedAt: p },
      height,
    );
  } else if (e.type === "order_cancelled" || e.type === "order_filled") {
    const order = get("order", e.key);
    if (!order || order.state !== "open")
      throw new ApiError(
        "MISSING_ORDER",
        "Terminal event without an open order.",
      );
    put(
      "order",
      e.key,
      {
        ...order,
        state: e.type === "order_filled" ? "filled" : "cancelled",
        updatedAt: p,
        settlement: e.type === "order_filled" ? e : null,
      },
      height,
    );
  } else if (e.type === "initialized") {
    put("config", "marketplace", { ...e, updatedAt: p }, height);
  } else if (e.type === "fee_policy_changed") {
    const cfg = get("config", "marketplace");
    if (!cfg) throw new ApiError("MISSING_CONFIG", "Missing initialization.");
    put(
      "config",
      "marketplace",
      { ...cfg, feeBps: e.feeBps, feeRecipient: e.feeRecipient, updatedAt: p },
      height,
    );
  } else if (e.type === "trading_changed") {
    const cfg = get("config", "marketplace");
    if (!cfg) throw new ApiError("MISSING_CONFIG", "Missing initialization.");
    put(
      "config",
      "marketplace",
      { ...cfg, paused: e.paused, updatedAt: p },
      height,
    );
  } else if (e.type === "collection_policy" || e.type === "currency_policy") {
    put(
      "policy",
      `${e.type}:${address(e.address)}`,
      { ...e, updatedAt: p },
      height,
    );
  } else if (e.type === "admin_transferred") {
    const cfg = get("config", "marketplace");
    if (!cfg) throw new ApiError("MISSING_CONFIG", "Missing initialization.");
    put(
      "config",
      "marketplace",
      { ...cfg, admin: e.admin, updatedAt: p },
      height,
    );
    put(
      "config",
      "pending_admin",
      { admin: address("0"), updatedAt: p },
      height,
    );
  } else if (e.type === "admin_proposed") {
    put("config", "pending_admin", { admin: e.admin, updatedAt: p }, height);
  } else if (e.type === "metadata_update") {
    put(
      "metadata_job",
      `${e.collection}:${e.tokenId ?? "*"}`,
      { ...e, state: "pending", updatedAt: p },
      height,
    );
  } else if (e.type === "undecodable" || e.type === "erc1155_transfer") {
    // Raw evidence is already canonical in chain.events; no market state is
    // derived here. ERC-1155 balance indexing lands with its own adapters
    // (#117), and an undecodable event is quarantined by the scanner (#112).
    return;
  } else throw new ApiError("UNKNOWN_EVENT", `Unsupported event: ${e.type}`);
  const id = `${p.blockHash}:${p.transactionHash}:${p.eventIndex}`;
  if (e.type === "order_filled") {
    const day = Math.floor(p.timestamp / 86400) * 86400,
      key = `${e.collection}:${e.currency}:${day}`,
      previous = get("stats_day", key);
    put(
      "stats_day",
      key,
      {
        collection: e.collection,
        currency: e.currency,
        day,
        volume: (
          BigInt(previous?.volume ?? "0") + BigInt(e.buyerDebit)
        ).toString(),
        sales: (previous?.sales ?? 0) + 1,
      },
      height,
    );
  }
  const notificationRecipients =
    e.type === "order_filled"
      ? [e.buyer, e.seller]
      : e.type === "order_created" && e.kind === "token_offer"
        ? [get("token", `${e.collection}:${e.tokenId}`)?.owner]
        : e.type === "order_cancelled"
          ? [e.maker]
          : [];
  put(
    "activity",
    id,
    {
      ...e,
      id,
      provenance: p,
      notificationRecipients: notificationRecipients.filter(Boolean),
    },
    height,
  );
}

export function projectionReads(e, p) {
  const keys = [];
  if (e.type === "transfer")
    keys.push(["token", `${address(e.collection)}:${uint(e.tokenId)}`]);
  if (["order_created", "order_filled", "order_cancelled"].includes(e.type))
    keys.push(["order", e.key]);
  if (
    ["fee_policy_changed", "trading_changed", "admin_transferred"].includes(
      e.type,
    )
  )
    keys.push(["config", "marketplace"]);
  if (e.type === "order_filled")
    keys.push([
      "stats_day",
      `${e.collection}:${e.currency}:${Math.floor(p.timestamp / 86400) * 86400}`,
    ]);
  if (e.type === "order_created" && e.kind === "token_offer")
    keys.push(["token", `${e.collection}:${e.tokenId}`]);
  return keys;
}
