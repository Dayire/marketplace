import { checkTransferLock } from "./collection-policy.mjs";
import { mapConcurrent } from "./concurrency.mjs";
import {
  address,
  uint,
  orderKey,
  u256Felts,
  fromU256,
  allocations,
  ApiError,
} from "./domain.mjs";
import { SELECTORS, readTerms } from "./decode.mjs";
import { collectionKey } from "./collection-catalog.mjs";
import { createCatalog } from "./catalog-access.mjs";
export async function preflight(store, rpc, config, input) {
  const account = address(input.account),
    items = input.items;
  if (!Array.isArray(items) || !items.length || items.length > 25)
    throw new ApiError("INVALID_CART", "Cart must contain 1–25 orders.");
  const keys = items.map((i) =>
    orderKey(config.chain, config.marketplace ?? "0", i.maker, i.nonce),
  );
  if (new Set(keys).size !== keys.length)
    throw new ApiError("DUPLICATE_ORDER", "Duplicate cart order.");
  // ERC-1155 collections are never checkout-eligible (#117): the shared
  // checkout path serves ERC-721 carts only.
  if (config.chainId)
    for (const [index] of items.entries()) {
      const indexed = await store.get("order", keys[index]);
      if (!indexed?.collection) continue;
      const record = await store.get(
        "catalog_collection",
        collectionKey(config.chainId, address(indexed.collection)),
      );
      if (record?.standard && record.standard !== "ERC721")
        return {
          canSubmit: false,
          reasons: ["ERC1155_NOT_CHECKOUT_ELIGIBLE"],
          rows: [],
          total: null,
        };
    }
  const status = await createCatalog(store, config).status();
  if (!status.safeForCheckout || !rpc)
    return {
      canSubmit: false,
      reasons: status.reasons.length ? status.reasons : ["RPC_UNAVAILABLE"],
      rows: [],
      total: null,
    };
  const block = await rpc.call("starknet_getBlockWithTxHashes", {
    block_id: "latest",
  });
  const blockId = { block_hash: block.block_hash };
  if (!["ACCEPTED_ON_L1", "ACCEPTED_ON_L2"].includes(block.status))
    throw new ApiError("INDEX_STALE", "Accepted chain head required.", 503);
  if (BigInt(await rpc.call("starknet_chainId", [])) !== BigInt(config.chainId))
    throw new ApiError("CHAIN_MISMATCH", "Wrong chain.", 503);
  if (
    BigInt(
      await rpc.call("starknet_getClassHashAt", {
        block_id: blockId,
        contract_address: config.marketplace,
      }),
    ) !== BigInt(config.marketplaceClassHash)
  )
    throw new ApiError("CLASS_MISMATCH", "Marketplace identity changed.", 503);
  const cfg = await rpc.contract(
    config.marketplace,
    SELECTORS.get_config,
    [],
    blockId,
  );
  if (cfg.length !== 5 || BigInt(cfg[0]) !== 1n || BigInt(cfg[2]) !== 0n)
    throw new ApiError("PAUSED", "Marketplace is paused or unsupported.", 409);
  const rows = [];
  let total = 0n,
    currency = null;
  const tokens = new Set();
  await mapConcurrent(items, 8, async (item, index) => {
    const key = keys[index];
    try {
      const indexed = await store.get("order", key);
      if (!indexed)
        throw new ApiError("MISSING_ORDER", "Order is not indexed.");
      const values = await rpc.contract(
        config.marketplace,
        SELECTORS.get_order,
        [address(item.maker), uint(item.nonce, 64)],
        blockId,
      );
      if (values.length !== 15 || BigInt(values[14]) !== 1n)
        throw new ApiError("NOT_OPEN", "Order is not open.");
      const order = readTerms(values.slice(0, 14));
      if (BigInt(order.expiry) <= BigInt(block.timestamp))
        throw new ApiError("EXPIRED", "Order expired.");
      for (const field of [
        "kind",
        "collection",
        "tokenId",
        "currency",
        "buyerDebit",
        "expiry",
        "royaltyCap",
        "feeBps",
        "royaltyAmount",
        "royaltyRecipient",
      ])
        if (indexed[field] !== order[field])
          throw new ApiError(
            "INDEX_DIVERGED",
            "Indexed terms differ from the chain.",
          );
      if (item.buyerDebit != null && uint(item.buyerDebit) !== order.buyerDebit)
        throw new ApiError("TERMS_CHANGED", "Price changed.");
      if (item.collection && address(item.collection) !== order.collection)
        throw new ApiError("TERMS_CHANGED", "Collection changed.");
      if (
        item.tokenId != null &&
        order.kind !== "collection_offer" &&
        uint(item.tokenId) !== order.tokenId
      )
        throw new ApiError("TERMS_CHANGED", "Token changed.");
      if (item.currency && address(item.currency) !== order.currency)
        throw new ApiError("TERMS_CHANGED", "Currency changed.");
      if (address(item.maker) === account)
        throw new ApiError("SELF_TRADE", "Cannot fill your own order.");
      const accepting = input.action === "accept";
      if (
        (!accepting && order.kind !== "listing") ||
        (accepting && order.kind === "listing")
      )
        throw new ApiError("WRONG_KIND", "Wrong order kind.");
      if (accepting && items.length !== 1)
        throw new ApiError("INVALID_CART", "Accept one offer at a time.");
      const tokenId =
        order.kind === "collection_offer" ? uint(item.tokenId) : order.tokenId;
      await checkTransferLock(rpc, config, order.collection, tokenId, blockId);
      const tokenKey = `${order.collection}:${tokenId}`;
      if (tokens.has(tokenKey))
        throw new ApiError("DUPLICATE_NFT", "NFT appears more than once.");
      tokens.add(tokenKey);
      const owner = await rpc.contract(
        order.collection,
        SELECTORS.owner_of,
        u256Felts(tokenId),
        blockId,
      );
      const seller = accepting ? account : address(item.maker),
        buyer = accepting ? address(item.maker) : account;
      if (owner.length !== 1 || address(owner[0]) !== seller)
        throw new ApiError("TRANSFERRED", "Seller no longer owns the NFT.");
      const operator = await rpc.contract(
        order.collection,
        SELECTORS.is_approved_for_all,
        [seller, config.marketplace],
        blockId,
      );
      let approved = operator.length === 1 && BigInt(operator[0]) === 1n;
      if (!approved) {
        const single = await rpc.contract(
          order.collection,
          SELECTORS.get_approved,
          u256Felts(tokenId),
          blockId,
        );
        approved =
          single.length === 1 &&
          address(single[0]) === address(config.marketplace);
      }
      if (!approved && !accepting)
        throw new ApiError(
          "NOT_APPROVED",
          "Seller has not approved the marketplace.",
        );
      let royalty = order.royaltyAmount,
        royaltyRecipient = order.royaltyRecipient;
      if (order.kind === "collection_offer") {
        const policy = await store.get(
          "policy",
          `collection_policy:${order.collection}`,
        );
        if (!policy?.enabled)
          throw new ApiError(
            "COLLECTION_DISABLED",
            "Collection disabled or not indexed.",
          );
        if (policy.royalties) {
          const result = await rpc.contract(
            order.collection,
            SELECTORS.royalty_info,
            [...u256Felts(tokenId), ...u256Felts(order.buyerDebit)],
            blockId,
          );
          if (result.length !== 3)
            throw new ApiError(
              "ROYALTY_UNAVAILABLE",
              "Invalid royalty response.",
            );
          royaltyRecipient = address(result[0]);
          royalty = fromU256(result[1], result[2]);
        } else {
          royalty = "0";
          royaltyRecipient = address("0");
        }
        if (BigInt(royalty) > BigInt(order.royaltyCap))
          throw new ApiError("ROYALTY_CAP", "Royalty exceeds maker limit.");
      }
      if (
        !(await store.get("policy", `currency_policy:${order.currency}`))
          ?.enabled ||
        !(await store.get("policy", `collection_policy:${order.collection}`))
          ?.enabled
      )
        throw new ApiError(
          "ASSET_DISABLED",
          "Asset is disabled or not indexed.",
        );
      const sourceProgress = await store.get("progress", order.collection);
      if (!sourceProgress || block.block_number - sourceProgress.block > 2)
        throw new ApiError("INDEX_STALE", "Collection index is behind.");
      const amounts = allocations(order.buyerDebit, order.feeBps, royalty);
      if (currency && currency !== order.currency)
        throw new ApiError("MIXED_CURRENCY", "Use one currency per checkout.");
      currency = order.currency;
      uint(total + BigInt(order.buyerDebit));
      total += BigInt(order.buyerDebit);
      rows[index] = {
        key,
        maker: address(item.maker),
        nonce: uint(item.nonce),
        tokenId,
        collection: order.collection,
        currency: order.currency,
        buyer,
        seller,
        royaltyRecipient,
        feeRecipient: address(cfg[4]),
        ...amounts,
        needsNftApproval: !approved,
        kind: order.kind,
        valid: true,
      };
    } catch (e) {
      rows[index] = {
        key,
        valid: false,
        code: e.code ?? "RPC_UNAVAILABLE",
        message: e.message,
      };
    }
  });
  const reasons = [];
  let approvalAmount = "0";
  if (rows.every((r) => r.valid) && currency) {
    const payer = rows[0].buyer;
    const [balance, allowance] = await Promise.all([
      rpc.contract(currency, SELECTORS.balance_of, [payer], blockId),
      rpc.contract(
        currency,
        SELECTORS.allowance,
        [payer, config.marketplace],
        blockId,
      ),
    ]);
    if (balance.length !== 2 || allowance.length !== 2)
      throw new ApiError(
        "RPC_UNAVAILABLE",
        "Invalid balance/allowance response.",
        503,
      );
    if (BigInt(fromU256(...balance)) < total)
      reasons.push("INSUFFICIENT_FUNDS");
    if (BigInt(fromU256(...allowance)) < total) {
      if (input.action === "accept") reasons.push("MAKER_ALLOWANCE");
      else approvalAmount = total.toString();
    }
  }
  return {
    canSubmit: rows.every((r) => r.valid) && !reasons.length,
    reasons,
    rows,
    currency,
    total: total.toString(),
    approvalAmount,
    blockNumber: block.block_number,
    blockHash: block.block_hash,
    expiresAt: Math.floor(Date.now() / 1000) + 15,
    marketplace: address(config.marketplace),
    chain: config.chain,
  };
}
