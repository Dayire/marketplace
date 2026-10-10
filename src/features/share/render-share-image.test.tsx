// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { CollectionShareData, TokenShareData } from "@/lib/marketplace/seo-data";
import {
  renderCollectionShareImage,
  renderShareImage,
  renderSiteShareImage,
  renderTokenShareImage,
} from "./render-share-image";

// `next/og` wraps the renderer in Next's request cache, which only exists inside
// the Next runtime. Use the same bundled renderer directly.
vi.mock("next/og", async () => {
  const og = await import("next/dist/compiled/@vercel/og/index.node.js");
  return { ImageResponse: og.ImageResponse };
});

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const LORDS = "0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49";

const listedRealm: TokenShareData = {
  exists: true,
  tokenName: "Stolsli",
  tokenId: "4",
  collectionName: "Realms",
  verified: true,
  price: { kind: "listing", amount: "27160000000000000000", currency: STRK, symbol: "STRK", display: "27.16" },
  traits: {
    layout: "resources",
    items: ["dragonhide", "mithral", "coal", "gold", "wood", "stone", "copper"].map((file) => ({
      label: "Resource",
      value: file[0].toUpperCase() + file.slice(1),
      icon: `/resources/${file}.png`,
    })),
  },
  artwork: ["/share/banners/realms.jpg"],
  version: "a",
};

async function expectPng(response: Response) {
  expect(response.headers.get("content-type")).toBe("image/png");
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(Array.from(bytes.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
  const view = new DataView(bytes.buffer);
  expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 630]);
}

describe("share images", () => {
  it("renders a listed Realm with resource icons and its price", async () => {
    const response = await renderTokenShareImage(listedRealm, { maxAge: 60 });

    await expectPng(response);
    expect(response.headers.get("cache-control")).toContain("max-age=60");
  });

  it("renders list traits, long names and every price state", async () => {
    const beast: TokenShareData = {
      ...listedRealm,
      tokenName: '"Grim Shout" Warlock of the Twilight Quartz Forest, Reborn',
      collectionName: "Beasts",
      verified: false,
      traits: {
        layout: "list",
        items: Array.from({ length: 7 }, (_, index) => ({
          label: `Very long trait label ${index}`,
          value: `A value that keeps going ${index}`,
        })),
      },
    };

    for (const price of [
      { ...listedRealm.price!, kind: "offer" as const, currency: LORDS, symbol: "LORDS", display: "1085.4" },
      { ...listedRealm.price!, kind: "sale" as const, display: "0.000000000000000001" },
      null,
    ]) {
      await expectPng(await renderTokenShareImage({ ...beast, price }, { maxAge: 60 }));
    }
  });

  it("renders an unavailable token without artwork", async () => {
    await expectPng(
      await renderTokenShareImage(
        {
          ...listedRealm,
          exists: false,
          tokenName: "Token #999",
          price: null,
          traits: { layout: "list", items: [] },
          artwork: [],
        },
        { maxAge: 60 },
      ),
    );
  });

  it("still renders when the artwork is malformed", async () => {
    const broken = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect')}`;

    await expectPng(await renderTokenShareImage({ ...listedRealm, artwork: [broken] }, { maxAge: 60 }));
  });

  it("falls back to the simpler card when a layout cannot render", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // The previous token image failed exactly like this: two children without flex.
    const invalid = (
      <div>
        <span>Token #</span>
        <span>4</span>
      </div>
    );

    await expectPng(
      await renderShareImage(invalid, <div style={{ display: "flex" }}>Token #4</div>, { maxAge: 60 }),
    );
    expect(error).toHaveBeenCalledWith(
      "[share-image] render failed; trying fallback",
      expect.anything(),
    );
    error.mockRestore();
  });

  it("renders collection and site cards", async () => {
    const collection: CollectionShareData = {
      exists: true,
      name: "Adventurers",
      description: "Every adventurer who entered the Loot Survivor dungeon, with their gear and stats.",
      verified: true,
      floor: { kind: "floor", amount: "1", currency: STRK, symbol: "STRK", display: "22.22" },
      listedCount: "412",
      supply: "18000",
      artwork: ["/share/banners/adventurers.jpg"],
      version: "b",
    };

    await expectPng(await renderCollectionShareImage(collection, { maxAge: 300 }));
    await expectPng(
      await renderCollectionShareImage(
        { ...collection, exists: false, floor: null, listedCount: null, supply: null, artwork: [] },
        { maxAge: 300 },
      ),
    );
    await expectPng(await renderSiteShareImage({ maxAge: 3600 }));
  });

  it("retries loading the fonts after a failed read", async () => {
    vi.resetModules();
    let failNextFontRead = true;
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        readFile: ((path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
          if (failNextFontRead && String(path).endsWith(".ttf")) {
            failNextFontRead = false;
            return Promise.reject(new Error("EMFILE: too many open files"));
          }
          return (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest);
        }) as typeof actual.readFile,
      };
    });

    try {
      const fresh = await import("./render-share-image");
      await expect(fresh.renderSiteShareImage({ maxAge: 60 })).rejects.toThrow("EMFILE");
      await expectPng(await fresh.renderSiteShareImage({ maxAge: 60 }));
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});
