import { beforeEach, describe, expect, it, vi } from "vitest";

describe("marketplace seo data server-safe imports", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns fallback collection metadata when sdk import fails", async () => {
    vi.doMock("@/lib/marketplace/config", () => ({
      getMarketplaceRuntimeConfig: () => ({
        chainLabel: "SN_SEPOLIA",
        warnings: [],
        sdkConfig: {
          chainId: "0x534e5f5345504f4c4941",
        },
        collections: [{ address: "0xabc", name: "Genesis", projectId: "project-a" }],
      }),
    }));

    vi.doMock("@/lib/marketplace/api-client", () => {
      throw new TypeError("(0 , g.createContext) is not a function");
    });

    const { getCollectionShareData } = await import("@/lib/marketplace/seo-data");
    const result = await getCollectionShareData("0xabc");

    expect(result).toMatchObject({
      exists: false,
      name: "Genesis",
      description: null,
      floor: null,
    });
  });
});
