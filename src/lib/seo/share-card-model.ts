import { formatAmount } from "@biblio/marketplace";
import { resourceIconSrc } from "@/components/marketplace/resource-icon";
import type { TokenActivityItem } from "@/features/token/token-activity";
import { normalizeMarketplaceAddress } from "@/lib/marketplace/address";
import {
  parseAmount,
  pickLastSale,
  pickTopOffer,
  sameCurrency,
  type MarketAmount,
} from "@/lib/marketplace/market-figures";
import {
  realmResources,
  tokenAttributes,
} from "@/lib/marketplace/token-attributes";
import { getTokenSymbol } from "@/lib/marketplace/token-display";
import type { ApiOrder } from "@/lib/marketplace/types";

/**
 * Pure view models for social share cards. Everything here is serialisable so
 * the same model can be cached, hashed into the image URL and rendered by both
 * `next/og` and Storybook.
 */

export type ShareCurrency = { address: string; symbol: string; decimals: number };

export type SharePrice = {
  /** What the amount represents; unlisted assets fall back to offers or sales. */
  kind: "listing" | "offer" | "sale" | "floor";
  /** Base units, lossless. */
  amount: string;
  currency: string;
  symbol: string;
  /** Exact decimal amount, as the asset page shows it. */
  display: string;
};

export type ShareTrait = { label: string; value: string; icon?: string | null };

export type ShareTraitSummary = {
  layout: "resources" | "list";
  items: ShareTrait[];
};

/** STRK, the asset page's default market currency. */
export const PREFERRED_SHARE_CURRENCY =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

export const MAX_SHARE_TRAITS = 7;
const MAX_TRAIT_VALUE_LENGTH = 32;
const DEFAULT_DECIMALS = 18;

function toSharePrice(
  kind: SharePrice["kind"],
  value: MarketAmount,
  currencies: ShareCurrency[],
  symbolHint?: string,
): SharePrice | null {
  const configured = currencies.find((currency) =>
    sameCurrency(currency.address, value.currency),
  );
  try {
    return {
      kind,
      amount: value.amount,
      currency: value.currency,
      symbol: configured?.symbol ?? symbolHint ?? getTokenSymbol(value.currency),
      display: formatAmount(value.amount, configured?.decimals ?? DEFAULT_DECIMALS),
    };
  } catch {
    return null;
  }
}

/** Currencies to try in turn: the preferred one, then the configured order. */
function currencyPreference(currencies: ShareCurrency[], preferredCurrency: string) {
  return [
    preferredCurrency,
    ...currencies
      .map((currency) => currency.address)
      .filter((address) => !sameCurrency(address, preferredCurrency)),
  ];
}

function sameAccount(left: string, right: string) {
  return normalizeMarketplaceAddress(left) === normalizeMarketplaceAddress(right);
}

/**
 * The price the asset page shows: the cheapest listing that can still fill
 * (open, unexpired, made by the current owner) in the preferred currency. When
 * none exists, the cheapest listing in the next configured currency, and then
 * in any other currency. Amounts are never compared across currencies.
 */
export function selectListingPrice({
  listings,
  owner,
  nowSeconds,
  currencies,
  preferredCurrency,
}: {
  listings: ApiOrder[];
  owner: string | null;
  nowSeconds: number;
  currencies: ShareCurrency[];
  preferredCurrency: string;
}): SharePrice | null {
  if (!owner) return null;

  const valid = listings.filter((order) => {
    if (order.kind !== "listing" || order.state !== "open") return false;
    if (parseAmount(order.buyerDebit) === null) return false;
    const expiry = parseAmount(order.expiry);
    if (expiry === null || expiry <= BigInt(nowSeconds)) return false;
    return sameAccount(order.maker, owner);
  });
  if (valid.length === 0) return null;

  const order = [
    ...currencyPreference(currencies, preferredCurrency),
    ...valid.map((listing) => listing.currency),
  ];
  for (const currency of order) {
    const pool = valid.filter((listing) => sameCurrency(listing.currency, currency));
    if (pool.length === 0) continue;
    const cheapest = pool.reduce((best, listing) =>
      (parseAmount(listing.buyerDebit) ?? 0n) < (parseAmount(best.buyerDebit) ?? 0n)
        ? listing
        : best,
    );
    return toSharePrice(
      "listing",
      { amount: cheapest.buyerDebit, currency: cheapest.currency },
      currencies,
    );
  }
  return null;
}

/** For an unlisted asset: the top offer, otherwise the most recent sale. */
export function selectUnlistedPrice({
  offers,
  activity,
  currencies,
  preferredCurrency,
}: {
  offers: ApiOrder[];
  activity: TokenActivityItem[];
  currencies: ShareCurrency[];
  preferredCurrency: string;
}): SharePrice | null {
  const topOffer = pickTopOffer(offers, preferredCurrency);
  if (topOffer) return toSharePrice("offer", topOffer, currencies);
  const lastSale = pickLastSale(activity);
  return lastSale ? toSharePrice("sale", lastSale, currencies) : null;
}

export function selectCollectionFloor({
  floors,
  currencies,
  preferredCurrency,
}: {
  floors: Array<{ currency: string; symbol?: string; price: string }>;
  currencies: ShareCurrency[];
  preferredCurrency: string;
}): SharePrice | null {
  const order = [
    ...currencyPreference(currencies, preferredCurrency),
    ...floors.map((floor) => floor.currency),
  ];
  for (const currency of order) {
    const floor = floors.find((entry) => sameCurrency(entry.currency, currency));
    if (floor && parseAmount(floor.price) !== null) {
      return toSharePrice(
        "floor",
        { amount: floor.price, currency: floor.currency },
        currencies,
        floor.symbol,
      );
    }
  }
  return null;
}

type NamedTrait = {
  label: string;
  /** Metadata trait names, matched without regard to case. */
  names: string[];
  /** Fall back to the token ID when the metadata has no matching trait. */
  tokenIdFallback?: boolean;
  /** Present the value as a number, e.g. "#88". */
  numbered?: boolean;
};

type ShareTraitRule =
  | { kind: "resources" }
  | { kind: "item-number" }
  | { kind: "named"; traits: NamedTrait[] };

/**
 * Per-collection trait selection, keyed by collection name. Collections not
 * listed show their first visible traits in the collection's browse order.
 */
const SHARE_TRAIT_RULES: Record<string, ShareTraitRule> = {
  realms: { kind: "resources" },
  "loot chests": {
    kind: "named",
    traits: [
      { label: "Epoch", names: ["Epoch"] },
      { label: "ID", names: ["ID", "Chest ID"], tokenIdFallback: true, numbered: true },
    ],
  },
  cosmetics: {
    kind: "named",
    traits: [
      { label: "Epoch", names: ["Epoch"] },
      { label: "Rarity", names: ["Rarity"] },
      { label: "Type", names: ["Type"] },
    ],
  },
  "golden token": { kind: "item-number" },
};

function shorten(value: string) {
  return value.length > MAX_TRAIT_VALUE_LENGTH
    ? `${value.slice(0, MAX_TRAIT_VALUE_LENGTH - 1).trimEnd()}…`
    : value;
}

/** A token ID in decimal; input that is not an integer is returned trimmed. */
export function decimalTokenId(tokenId: string) {
  try {
    return BigInt(tokenId.trim()).toString();
  } catch {
    return tokenId.trim();
  }
}

function numbered(value: string) {
  return value.startsWith("#") ? value : `#${value}`;
}

const sameName = (left: string, right: string) =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

export function summarizeShareTraits({
  collectionName,
  tokenId,
  metadata,
  hiddenTraits = [],
  orderedTraits = [],
}: {
  collectionName: string;
  tokenId: string;
  metadata: unknown;
  hiddenTraits?: string[];
  orderedTraits?: string[];
}): ShareTraitSummary {
  const rule = SHARE_TRAIT_RULES[collectionName.trim().toLowerCase()];

  if (rule?.kind === "resources") {
    return {
      layout: "resources",
      items: realmResources(metadata)
        .slice(0, MAX_SHARE_TRAITS)
        .map((resource) => ({
          label: "Resource",
          value: shorten(resource),
          icon: resourceIconSrc(resource),
        })),
    };
  }

  if (rule?.kind === "item-number") {
    return {
      layout: "list",
      items: [{ label: "Item", value: numbered(decimalTokenId(tokenId)) }],
    };
  }

  const rows = tokenAttributes(metadata);

  if (rule?.kind === "named") {
    const items = rule.traits.flatMap((trait): ShareTrait[] => {
      const row = rows.find((candidate) =>
        trait.names.some((name) => sameName(candidate.trait, name)),
      );
      const value = row?.value ?? (trait.tokenIdFallback ? decimalTokenId(tokenId) : null);
      if (!value) return [];
      return [{ label: trait.label, value: shorten(trait.numbered ? numbered(value) : value) }];
    });
    return { layout: "list", items };
  }

  const visible = rows.filter(
    (row) =>
      row.value.toLowerCase() !== "false" &&
      !hiddenTraits.some((hidden) => sameName(hidden, row.trait)),
  );
  const rank = (trait: string) => {
    const index = orderedTraits.findIndex((name) => sameName(name, trait));
    return index === -1 ? orderedTraits.length : index;
  };
  const sorted = visible
    .map((row, index) => ({ row, index }))
    .sort((left, right) => rank(left.row.trait) - rank(right.row.trait) || left.index - right.index)
    .map(({ row }) => row);

  return {
    layout: "list",
    items: sorted.slice(0, MAX_SHARE_TRAITS).map((row) => ({
      label: shorten(row.trait),
      value: shorten(row.value),
    })),
  };
}

/** Thousands separators for whole-number counts; other strings pass through. */
export function groupDigits(value: string) {
  return /^\d+$/.test(value) ? value.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : value;
}

/** Short, URL-safe content hash so a changed card gets a new image URL. */
export function shareCardVersion(content: unknown) {
  const text = JSON.stringify(content) ?? "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
