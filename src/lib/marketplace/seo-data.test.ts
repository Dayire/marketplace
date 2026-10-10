import { beforeEach, describe, expect, it, vi } from "vitest";

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const LORDS = "0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49";
const OWNER = "0x0abc";
const FUTURE = String(Math.floor(Date.now() / 1000) + 86_400);

const {
  mockCreateMarketplaceClient,
  mockGetCollection,
  mockGetToken,
  mockRequest,
  mockRuntimeConfig,
} = vi.hoisted(() => ({
  mockCreateMarketplaceClient: vi.fn(),
  mockGetCollection: vi.fn(),
  mockGetToken: vi.fn(),
  mockRequest: vi.fn(),
  mockRuntimeConfig: {
    chainLabel: "SN_SEPOLIA",
    warnings: [],
    sdkConfig: {
      chainId: "0x534e5f5345504f4c4941",
    },
    collections: [
      { address: "0xabc", name: "Realms", projectId: "project-a" },
    ],
  },
}));

vi.mock("@/lib/marketplace/api-client", () => ({
  createMarketplaceClient: mockCreateMarketplaceClient,
  marketplaceRequest: mockRequest,
}));

vi.mock("@/lib/marketplace/config", () => ({
  getMarketplaceRuntimeConfig: () => mockRuntimeConfig,
}));

function listing(overrides: Record<string, unknown> = {}) {
  return {
    apiOrder: {
      id: "l1",
      maker: OWNER,
      kind: "listing",
      state: "open",
      currency: STRK,
      buyerDebit: "27160000000000000000",
      expiry: FUTURE,
      ...overrides,
    },
  };
}

function token(listings: unknown[] = [], extra: Record<string, unknown> = {}) {
  return {
    token: {
      token_id: "4",
      owner: OWNER,
      image: "/api/marketplace/v1/chains/SN_MAIN/assets/" + "b".repeat(64) + ".png",
      metadata: {
        name: "Realms #4",
        description: "A realm by the sea.",
        attributes: [
          { trait_type: "Resource", value: "Coal" },
          { trait_type: "Resource", value: "Dragonhide" },
          { trait_type: "Cities", value: 8 },
        ],
      },
      ...extra,
    },
    listings,
  };
}

const collection = {
  address: "0xabc",
  verified: true,
  tokenCount: "8000",
  listingCount: "412",
  floorByCurrency: [
    { currency: LORDS, symbol: "LORDS", price: "1085400000000000000000" },
    { currency: STRK, symbol: "STRK", price: "22220000000000000000" },
  ],
  image: "/banners/realms.png",
  metadata: { name: "Realms", description: "8,000 Realms." },
};

function routeRequests(routes: Record<string, unknown>) {
  mockRequest.mockImplementation(async (path: string) => {
    if (path in routes) return routes[path];
    throw new Error(`unexpected request ${path}`);
  });
}

describe("marketplace share data", () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetCollection.mockReset();
    mockGetToken.mockReset();
    mockRequest.mockReset();
    mockCreateMarketplaceClient.mockReset();
    mockCreateMarketplaceClient.mockReturnValue({
      getCollection: mockGetCollection,
      getToken: mockGetToken,
    });
    routeRequests({
      "/marketplace/config": {
        currencies: [
          { address: STRK, symbol: "STRK", decimals: 18 },
          { address: LORDS, symbol: "LORDS", decimals: 18 },
        ],
      },
    });
  });

  it("builds a listed token card from the token, its listings and the collection", async () => {
    mockGetCollection.mockResolvedValue(collection);
    mockGetToken.mockResolvedValue(
      token([listing(), listing({ id: "l2", currency: LORDS, buyerDebit: "1" })]),
    );

    const { getTokenShareData } = await import("@/lib/marketplace/seo-data");
    const result = await getTokenShareData("0xabc", "4");

    expect(result).toMatchObject({
      exists: true,
      tokenName: "Realms #4",
      tokenId: "4",
      collectionName: "Realms",
      verified: true,
      price: { kind: "listing", display: "27.16", symbol: "STRK", currency: STRK },
      traits: {
        layout: "resources",
        items: [
          { value: "Dragonhide", icon: "/resources/dragonhide.png" },
          { value: "Coal", icon: "/resources/coal.png" },
        ],
      },
    });
    expect(result.artwork[0]).toBe(
      "/api/marketplace/v1/chains/SN_MAIN/assets/" + "b".repeat(64) + ".png",
    );
    expect(result.artwork).toContain("/share/banners/realms.jpg");
    expect(result.version).toMatch(/^[0-9a-z]+$/);
    // Listed assets need no offer or activity reads.
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("shows the top offer for an unlisted token, then the last sale", async () => {
    mockGetCollection.mockResolvedValue(collection);
    mockGetToken.mockResolvedValue(token([listing({ maker: "0xdead" })]));
    routeRequests({
      "/marketplace/config": { currencies: [{ address: STRK, symbol: "STRK", decimals: 18 }] },
      "/collections/0xabc/offers": {
        items: [{ kind: "token_offer", tokenId: "4", currency: STRK, buyerDebit: "12000000000000000000" }],
        nextCursor: null,
      },
      "/tokens/0xabc/4/activity": { items: [], nextCursor: null },
    });

    const { getTokenShareData } = await import("@/lib/marketplace/seo-data");
    const result = await getTokenShareData("0xabc", "4");

    expect(result.price).toMatchObject({ kind: "offer", display: "12" });
    expect(mockRequest).toHaveBeenCalledWith("/collections/0xabc/offers", {
      state: "open",
      tokenMatch: "4",
      limit: 50,
    });
  });

  it("retries the API client import after a failed load", async () => {
    let loads = 0;
    vi.doMock("@/lib/marketplace/api-client", () => {
      loads += 1;
      if (loads === 1) throw new Error("chunk load failed");
      return {
        createMarketplaceClient: mockCreateMarketplaceClient,
        marketplaceRequest: mockRequest,
      };
    });
    mockGetCollection.mockResolvedValue(collection);
    routeRequests({
      "/marketplace/config": { currencies: [] },
      "/collections/0xabc/offers": { items: [], nextCursor: null },
    });

    try {
      const { getCollectionShareData } = await import("@/lib/marketplace/seo-data");
      const first = await getCollectionShareData("0xabc");
      const second = await getCollectionShareData("0xabc");

      expect(first.exists).toBe(false);
      expect(second.exists).toBe(true);
    } finally {
      vi.doMock("@/lib/marketplace/api-client", () => ({
        createMarketplaceClient: mockCreateMarketplaceClient,
        marketplaceRequest: mockRequest,
      }));
    }
  });

  it("changes the version when the price changes", async () => {
    mockGetCollection.mockResolvedValue(collection);
    mockGetToken.mockResolvedValueOnce(token([listing()]));
    const first = await (await import("@/lib/marketplace/seo-data")).getTokenShareData("0xabc", "4");

    vi.resetModules();
    mockGetToken.mockResolvedValueOnce(token([listing({ buyerDebit: "30000000000000000000" })]));
    const second = await (await import("@/lib/marketplace/seo-data")).getTokenShareData("0xabc", "4");

    expect(second.price?.display).toBe("30");
    expect(second.version).not.toBe(first.version);
  });

  it("retries the token lookup with the alternate id format", async () => {
    mockGetCollection.mockResolvedValue(collection);
    mockGetToken.mockResolvedValueOnce(null).mockResolvedValueOnce(token());
    routeRequests({
      "/marketplace/config": { currencies: [] },
      "/collections/0xabc/offers": { items: [], nextCursor: null },
      "/tokens/0xabc/2357/activity": { items: [], nextCursor: null },
    });

    const { getTokenShareData } = await import("@/lib/marketplace/seo-data");
    const result = await getTokenShareData("0xabc", "2357");

    expect(result.exists).toBe(true);
    expect(mockGetToken).toHaveBeenNthCalledWith(2, {
      collection: "0xabc",
      tokenId: "0x935",
      projectId: "project-a",
      fetchImages: true,
    });
  });

  it("returns an unavailable card when the token is missing", async () => {
    mockGetCollection.mockResolvedValue(collection);
    mockGetToken.mockResolvedValue(null);

    const { getTokenShareData } = await import("@/lib/marketplace/seo-data");
    const result = await getTokenShareData("0xabc", "999");

    expect(result).toMatchObject({
      exists: false,
      tokenName: "Token #999",
      collectionName: "Realms",
      price: null,
      traits: { layout: "list", items: [] },
    });
    expect(result.artwork).toEqual(["/share/banners/realms.jpg", "/banners/realms.png"]);
  });

  it("falls back to Cosmetics' square artwork, then its banner, when token art cannot be used", async () => {
    mockGetCollection.mockResolvedValue({
      ...collection,
      image: null,
      metadata: { name: "Cosmetics" },
    });
    mockGetToken.mockResolvedValue(
      token([], { image: null, metadata: { name: "Legacy Keep", image: "ipfs://QmLegacyKeep" } }),
    );

    const { getTokenShareData, getCollectionShareData } = await import("@/lib/marketplace/seo-data");
    const tokenCard = await getTokenShareData("0xabc", "1");
    const collectionCard = await getCollectionShareData("0xabc");

    expect(tokenCard.artwork.slice(-2)).toEqual([
      "/collection-images/cosmetics.jpg",
      "/share/banners/cosmetics.jpg",
    ]);
    expect(collectionCard.artwork).toEqual(["/share/banners/cosmetics.jpg"]);
  });

  it("still returns a card when the client cannot start", async () => {
    mockCreateMarketplaceClient.mockImplementation(() => {
      throw new Error("init failed");
    });

    const { getTokenShareData, getCollectionShareData } = await import("@/lib/marketplace/seo-data");

    await expect(getTokenShareData("0xabc", "7")).resolves.toMatchObject({
      exists: false,
      tokenName: "Token #7",
      collectionName: "Realms",
      price: null,
    });
    await expect(getCollectionShareData("0xabc")).resolves.toMatchObject({
      exists: false,
      name: "Realms",
      floor: null,
    });
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("fetches the collection and token in parallel", async () => {
    const callLog: string[] = [];
    const delay = 50;
    mockGetCollection.mockImplementation(async () => {
      callLog.push("collection:start");
      await new Promise((resolve) => setTimeout(resolve, delay));
      return collection;
    });
    mockGetToken.mockImplementation(async () => {
      callLog.push("token:start");
      await new Promise((resolve) => setTimeout(resolve, delay));
      return token([listing()]);
    });

    const { getTokenShareData } = await import("@/lib/marketplace/seo-data");
    const start = Date.now();
    await getTokenShareData("0xabc", "4");

    expect(callLog.slice(0, 2).sort()).toEqual(["collection:start", "token:start"]);
    expect(Date.now() - start).toBeLessThan(delay * 2 - 10);
  });

  it("builds a collection card with floor, listed count, supply and banner art", async () => {
    mockGetCollection.mockResolvedValue(collection);

    const { getCollectionShareData } = await import("@/lib/marketplace/seo-data");
    const result = await getCollectionShareData("0xabc");

    expect(result).toMatchObject({
      exists: true,
      name: "Realms",
      description: "8,000 Realms.",
      verified: true,
      floor: { kind: "floor", display: "22.22", symbol: "STRK" },
      listedCount: "412",
      supply: "8000",
    });
    expect(result.artwork[0]).toBe("/share/banners/realms.jpg");
    expect(mockGetCollection).toHaveBeenCalledWith({
      address: "0xabc",
      projectId: "project-a",
      fetchImages: true,
    });
  });

  it("shortens unknown collection addresses", async () => {
    mockGetCollection.mockRejectedValue(new Error("Collection not indexed"));
    const address = "0x0572fe34a769058c62a66f0c4854d08ccfd21fcbb4f0b1685a1868b84c6ee266";

    const { getCollectionShareData } = await import("@/lib/marketplace/seo-data");
    const result = await getCollectionShareData(address);

    expect(result).toMatchObject({ exists: false, name: "0x0572...e266", artwork: [] });
  });
});
