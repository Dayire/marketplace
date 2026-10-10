import { describe, expect, it } from "vitest";
import type { ApiOrder } from "@/lib/marketplace/types";
import type { TokenActivityItem } from "@/features/token/token-activity";
import {
  selectCollectionFloor,
  selectListingPrice,
  selectUnlistedPrice,
  shareCardVersion,
  summarizeShareTraits,
  type ShareCurrency,
} from "./share-card-model";

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const LORDS = "0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49";
const OWNER = "0x0000000000000000000000000000000000000000000000000000000000000abc";
const NOW = 1_800_000_000;

const CURRENCIES: ShareCurrency[] = [
  { address: STRK, symbol: "STRK", decimals: 18 },
  { address: LORDS, symbol: "LORDS", decimals: 18 },
];

const units = (whole: string) => (BigInt(whole) * 10n ** 16n).toString(); // hundredths

function order(overrides: Partial<ApiOrder>): ApiOrder {
  return {
    id: overrides.id ?? `order-${Math.random()}`,
    maker: OWNER,
    nonce: "1",
    kind: "listing",
    state: "open",
    collection: "0xc0",
    tokenId: "4",
    currency: STRK,
    buyerDebit: units("2716"),
    expiry: String(NOW + 3600),
    royaltyAmount: "0",
    royaltyCap: "0",
    royaltyRecipient: "0x0",
    feeBps: 200,
    ...overrides,
  };
}

function priceInput(listings: ApiOrder[], owner: string | null = OWNER) {
  return {
    listings,
    owner,
    nowSeconds: NOW,
    currencies: CURRENCIES,
    preferredCurrency: STRK,
  };
}

describe("selectListingPrice", () => {
  it("shows the cheapest valid listing in the preferred currency, as the asset page does", () => {
    const price = selectListingPrice(
      priceInput([
        order({ buyerDebit: units("3000") }),
        order({ buyerDebit: units("2716") }),
        order({ currency: LORDS, buyerDebit: units("1") }),
      ]),
    );

    expect(price).toEqual({
      kind: "listing",
      amount: units("2716"),
      currency: STRK,
      symbol: "STRK",
      display: "27.16",
    });
  });

  it("falls back to the cheapest listing in the next configured currency", () => {
    const price = selectListingPrice(
      priceInput([
        order({ currency: LORDS, buyerDebit: units("108540") }),
        order({ currency: LORDS, buyerDebit: units("120000") }),
      ]),
    );

    expect(price).toMatchObject({ kind: "listing", symbol: "LORDS", display: "1085.4" });
  });

  it("ignores expired, closed, transferred and malformed listings", () => {
    const price = selectListingPrice(
      priceInput([
        order({ buyerDebit: units("1"), expiry: String(NOW) }),
        order({ buyerDebit: units("2"), state: "filled" }),
        order({ buyerDebit: units("3"), maker: "0xdead" }),
        order({ buyerDebit: "not-a-number" }),
        order({ buyerDebit: units("4"), kind: "token_offer" }),
      ]),
    );

    expect(price).toBeNull();
  });

  it("matches the owner regardless of address padding", () => {
    const price = selectListingPrice(priceInput([order({ maker: "0xABC" })]));
    expect(price?.display).toBe("27.16");
  });

  it("does not trust listings when the owner is unknown", () => {
    expect(selectListingPrice(priceInput([order({})], null))).toBeNull();
  });

  it("labels an unconfigured currency without guessing decimals beyond the app default", () => {
    const other = "0x0000000000000000000000000000000000000000000000000000000000000777";
    const price = selectListingPrice(
      priceInput([order({ currency: other, buyerDebit: "1500000000000000000" })]),
    );

    expect(price).toMatchObject({ currency: other, display: "1.5" });
    expect(price?.symbol).toBe("0x0000...0777");
  });
});

function activity(
  id: string,
  type: string,
  timestamp: number,
  buyerDebit?: string,
  currency = STRK,
): TokenActivityItem {
  return { id, type, buyerDebit, currency, provenance: { timestamp } };
}

describe("selectUnlistedPrice", () => {
  const base = { currencies: CURRENCIES, preferredCurrency: STRK };

  it("prefers the top offer over the last sale", () => {
    const price = selectUnlistedPrice({
      ...base,
      offers: [
        order({ kind: "token_offer", buyerDebit: units("900") }),
        order({ kind: "collection_offer", tokenId: null, buyerDebit: units("1200") }),
      ],
      activity: [activity("s", "order_filled", 10, units("5000"))],
    });

    expect(price).toMatchObject({ kind: "offer", display: "12", symbol: "STRK" });
  });

  it("uses the most recent sale when there are no offers", () => {
    const price = selectUnlistedPrice({
      ...base,
      offers: [],
      activity: [
        activity("old", "order_filled", 10, units("100")),
        activity("new", "order_filled", 20, units("4250"), LORDS),
        activity("t", "transfer", 30),
      ],
    });

    expect(price).toMatchObject({ kind: "sale", display: "42.5", symbol: "LORDS" });
  });

  it("returns null when the asset has no market history", () => {
    expect(selectUnlistedPrice({ ...base, offers: [], activity: [] })).toBeNull();
  });
});

describe("selectCollectionFloor", () => {
  it("prefers the preferred currency floor, then configured order", () => {
    expect(
      selectCollectionFloor({
        floors: [
          { currency: LORDS, symbol: "LORDS", price: units("108540") },
          { currency: STRK, symbol: "STRK", price: units("2222") },
        ],
        currencies: CURRENCIES,
        preferredCurrency: STRK,
      }),
    ).toMatchObject({ kind: "floor", display: "22.22", symbol: "STRK" });

    expect(
      selectCollectionFloor({
        floors: [{ currency: LORDS, symbol: "LORDS", price: units("108540") }],
        currencies: CURRENCIES,
        preferredCurrency: STRK,
      }),
    ).toMatchObject({ kind: "floor", symbol: "LORDS" });

    expect(
      selectCollectionFloor({ floors: [], currencies: CURRENCIES, preferredCurrency: STRK }),
    ).toBeNull();
  });
});

function metadata(attributes: Array<[string, unknown]>) {
  return {
    attributes: attributes.map(([trait_type, value]) => ({ trait_type, value })),
  };
}

describe("summarizeShareTraits", () => {
  it("shows only Realm resources, rarest first, as icons", () => {
    const summary = summarizeShareTraits({
      collectionName: "Realms",
      tokenId: "4",
      metadata: metadata([
        ["Resource", "Wood"],
        ["Resource", "Dragonhide"],
        ["Resource", "Coal"],
        ["Cities", 8],
        ["Order", "Giants"],
      ]),
    });

    expect(summary).toEqual({
      layout: "resources",
      items: [
        { label: "Resource", value: "Dragonhide", icon: "/resources/dragonhide.png" },
        { label: "Resource", value: "Coal", icon: "/resources/coal.png" },
        { label: "Resource", value: "Wood", icon: "/resources/wood.png" },
      ],
    });
  });

  it("caps Realm resources at seven", () => {
    const resources = ["Wood", "Stone", "Coal", "Copper", "Obsidian", "Silver", "Ironwood", "Gold"];
    const summary = summarizeShareTraits({
      collectionName: "Realms",
      tokenId: "1",
      metadata: metadata(resources.map((resource) => ["Resource", resource])),
    });

    expect(summary.items).toHaveLength(7);
  });

  it("shows epoch and ID for Loot Chests", () => {
    const summary = summarizeShareTraits({
      collectionName: "Loot Chests",
      tokenId: "2357",
      metadata: metadata([
        ["Tier", "Rare"],
        ["epoch", "3"],
        ["Source", "Blitz"],
      ]),
    });

    expect(summary).toEqual({
      layout: "list",
      items: [
        { label: "Epoch", value: "3" },
        { label: "ID", value: "#2357" },
      ],
    });
  });

  it("prefers a Loot Chest ID trait over the token ID", () => {
    const summary = summarizeShareTraits({
      collectionName: "loot chests",
      tokenId: "2357",
      metadata: metadata([["ID", "88"]]),
    });

    expect(summary.items).toEqual([{ label: "ID", value: "#88" }]);
  });

  it("shows epoch, rarity and type for Cosmetics but not the epoch item number", () => {
    const summary = summarizeShareTraits({
      collectionName: "Cosmetics",
      tokenId: "12",
      metadata: metadata([
        ["Epoch Item Number", "41"],
        ["Type", "Armor"],
        ["Rarity", "Legendary"],
        ["Epoch", "2"],
      ]),
    });

    expect(summary.items).toEqual([
      { label: "Epoch", value: "2" },
      { label: "Rarity", value: "Legendary" },
      { label: "Type", value: "Armor" },
    ]);
  });

  it("shows only the item number for Golden Tokens", () => {
    const summary = summarizeShareTraits({
      collectionName: "Golden Token",
      tokenId: "0x460",
      metadata: metadata([["Anything", "ignored"]]),
    });

    expect(summary.items).toEqual([{ label: "Item", value: "#1120" }]);
  });

  it("uses the first seven visible traits elsewhere, honouring collection order and hidden traits", () => {
    const summary = summarizeShareTraits({
      collectionName: "Beasts",
      tokenId: "9",
      hiddenTraits: ["Beast ID"],
      orderedTraits: ["Beast", "Type", "Tier"],
      metadata: metadata([
        ["Beast ID", "77"],
        ["Level", 12],
        ["Tier", 2],
        ["Shiny", false],
        ["Beast", "Dragon"],
        ["Type", "Magic"],
        ["Power", 400],
        ["Health", 300],
        ["Prefix", "Grim"],
        ["Suffix", "Shout"],
      ]),
    });

    expect(summary).toEqual({
      layout: "list",
      items: [
        { label: "Beast", value: "Dragon" },
        { label: "Type", value: "Magic" },
        { label: "Tier", value: "2" },
        { label: "Level", value: "12" },
        { label: "Power", value: "400" },
        { label: "Health", value: "300" },
        { label: "Prefix", value: "Grim" },
      ],
    });
  });

  it("returns no traits when metadata has none", () => {
    expect(
      summarizeShareTraits({ collectionName: "Adventurers", tokenId: "1", metadata: null }),
    ).toEqual({ layout: "list", items: [] });
  });

  it("shortens very long trait values", () => {
    const summary = summarizeShareTraits({
      collectionName: "Adventurers",
      tokenId: "1",
      metadata: metadata([["Name", "A".repeat(80)]]),
    });

    expect(summary.items[0].value.length).toBeLessThanOrEqual(32);
    expect(summary.items[0].value.endsWith("…")).toBe(true);
  });
});

describe("shareCardVersion", () => {
  it("is stable for equal content and changes with the price", () => {
    const listed = { name: "Realms #4", price: { amount: "1" } };
    expect(shareCardVersion(listed)).toBe(shareCardVersion({ ...listed }));
    expect(shareCardVersion(listed)).not.toBe(
      shareCardVersion({ ...listed, price: { amount: "2" } }),
    );
    expect(shareCardVersion(listed)).toMatch(/^[0-9a-z]+$/);
  });
});
