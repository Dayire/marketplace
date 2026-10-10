import { describe, expect, it } from "vitest";
import {
  getCollectionBannerImage,
  getCollectionImage,
  getCollectionShareBanner,
  SHARE_BANNERS,
} from "./collection-banners";

describe("getCollectionImage", () => {
  it("uses dedicated artwork for Cosmetics, matched case- and whitespace-insensitively", () => {
    expect(getCollectionImage("Cosmetics")).toBe("/collection-images/cosmetics.jpg");
    expect(getCollectionImage("  cosmetics ")).toBe("/collection-images/cosmetics.jpg");
  });

  it("falls back to the banner for collections without dedicated artwork", () => {
    expect(getCollectionImage("Realms")).toBe("/banners/realms.png");
  });

  it("returns null for unknown or missing names", () => {
    expect(getCollectionImage("Unknown")).toBeNull();
    expect(getCollectionImage(null)).toBeNull();
    expect(getCollectionImage("")).toBeNull();
  });
});

describe("getCollectionBannerImage", () => {
  it("uses the item collage as the Cosmetics banner, separate from its square artwork", () => {
    expect(getCollectionBannerImage("Cosmetics")).toBe("/banners/cosmetics.jpg");
    expect(getCollectionImage("Cosmetics")).toBe("/collection-images/cosmetics.jpg");
  });
});

describe("getCollectionShareBanner", () => {
  it("has a downscaled share banner for every collection banner, Cosmetics included", () => {
    expect(getCollectionShareBanner("  Cosmetics ")).toBe("/share/banners/cosmetics.jpg");
    expect(getCollectionShareBanner("Unknown")).toBeNull();
    expect(getCollectionShareBanner(null)).toBeNull();
    expect(SHARE_BANNERS).toHaveLength(6);
  });
});
