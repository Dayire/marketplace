import type { Metadata } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetCollectionShareData } = vi.hoisted(() => ({
  mockGetCollectionShareData: vi.fn(),
}));

vi.mock("@/lib/marketplace/seo-data", () => ({
  getCollectionShareData: mockGetCollectionShareData,
}));

vi.mock("@/features/collections/collection-route-container", () => ({
  CollectionRouteContainer: () => null,
}));

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

async function metadataFor(address: string) {
  const { generateMetadata } = await import("@/app/collections/[address]/page");
  return (await generateMetadata({
    params: Promise.resolve({ address }),
    searchParams: Promise.resolve({}),
  })) as Metadata;
}

describe("collection page metadata", () => {
  beforeEach(() => {
    mockGetCollectionShareData.mockReset();
    process.env.NEXT_PUBLIC_SITE_URL = "https://market.realms.world";
  });

  it("points social previews at the versioned collection card", async () => {
    mockGetCollectionShareData.mockResolvedValue({
      exists: true,
      name: "Realms",
      description: "8,000 Realms.",
      verified: true,
      floor: { kind: "floor", amount: "1", currency: STRK, symbol: "STRK", display: "22.22" },
      listedCount: "412",
      supply: "8000",
      artwork: [],
      version: "c0ll",
    });

    const metadata = await metadataFor("0xabc");
    const image = {
      url: "https://market.realms.world/collections/0xabc/opengraph-image?v=c0ll",
      width: 1200,
      height: 630,
      type: "image/png",
      alt: "Realms on Realms.market, floor 22.22 STRK",
    };

    expect(metadata.title).toBe("Realms | Realms.market");
    expect(metadata.description).toBe("8,000 Realms. Floor 22.22 STRK, 412 listed of 8,000.");
    expect(metadata.alternates?.canonical).toBe("https://market.realms.world/collections/0xabc");
    expect(metadata.openGraph?.images).toEqual([image]);
    expect(metadata.twitter?.images).toEqual([image]);
    expect(metadata.robots).toEqual({ index: true, follow: true });
  });

  it("keeps unknown collections out of search", async () => {
    mockGetCollectionShareData.mockResolvedValue({
      exists: false,
      name: "0x0404...0404",
      description: null,
      verified: false,
      floor: null,
      listedCount: null,
      supply: null,
      artwork: [],
      version: "x",
    });

    const metadata = await metadataFor("0x0404");

    expect(metadata.title).toBe("Collection 0x0404...0404 | Realms.market");
    expect(metadata.description).toBe("Collection 0x0404...0404 is unavailable on Realms.market.");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
