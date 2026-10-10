import type { Metadata } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetTokenShareData } = vi.hoisted(() => ({
  mockGetTokenShareData: vi.fn(),
}));

vi.mock("@/lib/marketplace/seo-data", () => ({
  getTokenShareData: mockGetTokenShareData,
}));

vi.mock("@/features/token/token-detail-view", () => ({
  TokenDetailView: () => null,
}));

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

const listed = {
  exists: true,
  tokenName: "Realms #4",
  tokenId: "4",
  collectionName: "Realms",
  verified: true,
  description: null,
  price: { kind: "listing", amount: "1", currency: STRK, symbol: "STRK", display: "27.16" },
  traits: {
    layout: "resources",
    items: [
      { label: "Resource", value: "Dragonhide", icon: "/resources/dragonhide.png" },
      { label: "Resource", value: "Coal", icon: "/resources/coal.png" },
    ],
  },
  artwork: [],
  version: "k3x9",
};

async function metadataFor(address: string, tokenId: string) {
  const { generateMetadata } = await import("@/app/collections/[address]/[tokenId]/page");
  return (await generateMetadata({
    params: Promise.resolve({ address, tokenId }),
  })) as Metadata;
}

describe("token page metadata", () => {
  beforeEach(() => {
    mockGetTokenShareData.mockReset();
    process.env.NEXT_PUBLIC_SITE_URL = "https://market.realms.world";
  });

  it("points social previews at the versioned share card with the listing price", async () => {
    mockGetTokenShareData.mockResolvedValue(listed);

    const metadata = await metadataFor("0xabc", "4");
    const image = {
      url: "https://market.realms.world/collections/0xabc/4/opengraph-image?v=k3x9",
      width: 1200,
      height: 630,
      type: "image/png",
      alt: "Realms #4 from Realms, listed for 27.16 STRK",
    };

    expect(metadata.title).toBe("Realms #4 | Realms | Realms.market");
    expect(metadata.openGraph?.title).toBe("Realms #4 for 27.16 STRK");
    expect(metadata.twitter?.title).toBe("Realms #4 for 27.16 STRK");
    expect(metadata.description).toBe(
      "Realms #4 from Realms is listed for 27.16 STRK on Realms.market. Resources: Dragonhide, Coal.",
    );
    expect(metadata.alternates?.canonical).toBe("https://market.realms.world/collections/0xabc/4");
    expect(metadata.openGraph?.images).toEqual([image]);
    expect(metadata.twitter?.images).toEqual([image]);
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
    expect(metadata.robots).toEqual({ index: true, follow: true });
  });

  it("describes unlisted assets by their top offer and list traits", async () => {
    mockGetTokenShareData.mockResolvedValue({
      ...listed,
      tokenName: "Cosmetic Robe",
      collectionName: "Cosmetics",
      price: { ...listed.price, kind: "offer", display: "12" },
      traits: {
        layout: "list",
        items: [
          { label: "Epoch", value: "2" },
          { label: "Rarity", value: "Legendary" },
        ],
      },
    });

    const metadata = await metadataFor("0xabc", "7");

    expect(metadata.openGraph?.title).toBe("Cosmetic Robe");
    expect(metadata.description).toBe(
      "Cosmetic Robe from Cosmetics on Realms.market. Top offer: 12 STRK. Epoch: 2. Rarity: Legendary.",
    );
  });

  it("keeps missing tokens out of search while still giving them a card", async () => {
    mockGetTokenShareData.mockResolvedValue({
      ...listed,
      exists: false,
      tokenName: "Token #999",
      price: null,
      traits: { layout: "list", items: [] },
      version: "zz",
    });

    const metadata = await metadataFor("0xabc", "999");

    expect(metadata.title).toBe("Token #999 | Realms | Realms.market");
    expect(metadata.description).toBe("Token #999 is unavailable on Realms.market.");
    expect(metadata.openGraph?.images).toEqual([
      expect.objectContaining({
        url: "https://market.realms.world/collections/0xabc/999/opengraph-image?v=zz",
      }),
    ]);
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
