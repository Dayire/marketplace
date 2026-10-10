import type { ApiOrder } from "@/lib/marketplace/types";
import type { TokenActivityItem } from "@/features/token/token-activity";

/**
 * Market figures shared by the token page and server-rendered share cards.
 * Kept free of client-only modules so server routes can import it.
 */
export type MarketAmount = { amount: string; currency: string };

export function sameCurrency(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

/** A base-unit amount as a bigint, or null when it is not an integer. */
export function parseAmount(value: string) {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Highest open offer, compared within one currency: the preferred currency
 * when any offer uses it, otherwise the currency of the leading offer.
 */
export function pickTopOffer(
  orders: ApiOrder[],
  preferredCurrency?: string | null,
): MarketAmount | null {
  const offers = orders.filter(
    (order) =>
      order.kind !== "listing" && parseAmount(order.buyerDebit) !== null,
  );
  if (offers.length === 0) return null;

  const preferred = preferredCurrency
    ? offers.filter((order) => sameCurrency(order.currency, preferredCurrency))
    : [];
  const pool =
    preferred.length > 0
      ? preferred
      : offers.filter((order) =>
          sameCurrency(order.currency, offers[0].currency),
        );

  let best = pool[0];
  let bestAmount = parseAmount(best.buyerDebit) ?? 0n;
  for (const order of pool) {
    const amount = parseAmount(order.buyerDebit) ?? 0n;
    if (amount > bestAmount) {
      best = order;
      bestAmount = amount;
    }
  }
  return { amount: best.buyerDebit, currency: best.currency };
}

/** The most recent fill carrying an amount, whatever order the events arrive in. */
export function pickLastSale(items: TokenActivityItem[]): MarketAmount | null {
  let latest: TokenActivityItem | null = null;
  for (const item of items) {
    if (item.type !== "order_filled" || !item.buyerDebit || !item.currency)
      continue;
    if (!latest || item.provenance.timestamp > latest.provenance.timestamp) {
      latest = item;
    }
  }
  return latest && latest.buyerDebit && latest.currency
    ? { amount: latest.buyerDebit, currency: latest.currency }
    : null;
}
