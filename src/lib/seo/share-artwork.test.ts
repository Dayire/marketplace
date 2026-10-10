// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { loadShareArtwork, shareImageDataUri, type ShareArtworkSources } from "./share-artwork";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const WEBP = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");
const SVG = new TextEncoder().encode(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>',
);
const SHA = "a".repeat(64);

function sources(overrides: Partial<ShareArtworkSources> = {}): ShareArtworkSources {
  return {
    readPublicFile: vi.fn(async () => null),
    fetchCachedAsset: vi.fn(async () => null),
    ...overrides,
  };
}

describe("shareImageDataUri", () => {
  it("accepts formats the renderer can decode", () => {
    expect(shareImageDataUri(PNG)).toMatch(/^data:image\/png;base64,/);
    expect(shareImageDataUri(JPEG)).toMatch(/^data:image\/jpeg;base64,/);
    expect(shareImageDataUri(new TextEncoder().encode("GIF89a...."))).toMatch(
      /^data:image\/gif;base64,/,
    );
    expect(shareImageDataUri(SVG)).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("rejects WebP, unknown bytes and SVGs without a size", () => {
    expect(shareImageDataUri(WEBP)).toBeNull();
    expect(shareImageDataUri(new TextEncoder().encode("hello"))).toBeNull();
    expect(
      shareImageDataUri(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')),
    ).toBeNull();
  });

  it("rejects oversized images", () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    big.set(PNG);
    expect(shareImageDataUri(big)).toBeNull();
  });
});

describe("loadShareArtwork", () => {
  it("loads a backend-cached asset through the internal API, whatever origin the URL names", async () => {
    const io = sources({ fetchCachedAsset: vi.fn(async () => PNG) });

    await expect(
      loadShareArtwork([`/api/marketplace/v1/chains/SN_MAIN/assets/${SHA}.png`], io),
    ).resolves.toMatch(/^data:image\/png;base64,/);
    await loadShareArtwork([`https://cdn.example.com/v1/chains/SN_MAIN/assets/${SHA}.jpg`], io);

    expect(io.fetchCachedAsset).toHaveBeenNthCalledWith(1, "SN_MAIN", `${SHA}.png`);
    expect(io.fetchCachedAsset).toHaveBeenNthCalledWith(2, "SN_MAIN", `${SHA}.jpg`);
  });

  it("skips cached WebP assets without fetching them", async () => {
    const io = sources({ readPublicFile: vi.fn(async () => JPEG) });

    await expect(
      loadShareArtwork(
        [`/api/marketplace/v1/chains/SN_MAIN/assets/${SHA}.webp`, "/banners/beasts.jpg"],
        io,
      ),
    ).resolves.toMatch(/^data:image\/jpeg;base64,/);
    expect(io.fetchCachedAsset).not.toHaveBeenCalled();
  });

  it("reads local public files but never escapes the public directory", async () => {
    const io = sources({ readPublicFile: vi.fn(async () => PNG) });

    await expect(loadShareArtwork(["/banners/realms.png"], io)).resolves.toMatch(/^data:image\/png/);
    expect(io.readPublicFile).toHaveBeenCalledWith("banners/realms.png");

    const blocked = sources({ readPublicFile: vi.fn(async () => PNG) });
    await expect(
      loadShareArtwork(["/../.env.production.png", "/banners/%2e%2e/x.png", "/api/secret.png"], blocked),
    ).resolves.toBeNull();
    expect(blocked.readPublicFile).not.toHaveBeenCalled();
  });

  it("decodes inline data URIs and never fetches remote origins", async () => {
    const io = sources();
    const inline = `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`;
    const utf8 = `data:image/svg+xml;utf8,${encodeURIComponent(new TextDecoder().decode(SVG))}`;

    await expect(loadShareArtwork([inline], io)).resolves.toMatch(/^data:image\/svg\+xml;base64,/);
    await expect(loadShareArtwork([utf8], io)).resolves.toMatch(/^data:image\/svg\+xml;base64,/);
    await expect(
      loadShareArtwork(
        ["https://evil.example/token.png", "ipfs://Qm123", "http://10.0.0.1/admin.png"],
        io,
      ),
    ).resolves.toBeNull();
    expect(io.fetchCachedAsset).not.toHaveBeenCalled();
    expect(io.readPublicFile).not.toHaveBeenCalled();
  });

  it("moves on when a source fails or returns undecodable bytes", async () => {
    const io = sources({
      fetchCachedAsset: vi.fn(async () => {
        throw new Error("timeout");
      }),
      readPublicFile: vi
        .fn<ShareArtworkSources["readPublicFile"]>()
        .mockResolvedValueOnce(WEBP)
        .mockResolvedValueOnce(PNG),
    });

    await expect(
      loadShareArtwork(
        [
          null,
          `/api/marketplace/v1/chains/SN_MAIN/assets/${SHA}.png`,
          "/placeholders/odd.png",
          "/banners/realms.png",
        ],
        io,
      ),
    ).resolves.toMatch(/^data:image\/png/);
  });
});

describe("defaultShareArtworkSources.fetchCachedAsset", () => {
  it("reads assets from the internal API without following redirects or reading oversized bodies", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((request, response) => {
      if (request.url?.endsWith(`/${SHA}.png`)) {
        response.writeHead(200, { "Content-Type": "image/png" }).end(Buffer.from(PNG));
      } else if (request.url?.endsWith(`/${SHA}.gif`)) {
        response.writeHead(302, { Location: "http://169.254.169.254/" }).end();
      } else if (request.url?.endsWith(`/${SHA}.jpg`)) {
        response.writeHead(200).end(Buffer.alloc(6 * 1024 * 1024));
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const previous = process.env.MARKETPLACE_API_URL;
    process.env.MARKETPLACE_API_URL = `http://127.0.0.1:${port}/`;

    try {
      const { defaultShareArtworkSources: io } = await import("./share-artwork");
      await expect(io.fetchCachedAsset("SN_MAIN", `${SHA}.png`)).resolves.toEqual(PNG);
      await expect(io.fetchCachedAsset("SN_MAIN", `${SHA}.gif`)).resolves.toBeNull();
      await expect(io.fetchCachedAsset("SN_MAIN", `${SHA}.jpg`)).resolves.toBeNull();
      await expect(io.fetchCachedAsset("SN_MAIN", `${SHA}.svg`)).resolves.toBeNull();
    } finally {
      process.env.MARKETPLACE_API_URL = previous;
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("defaultShareArtworkSources.readPublicFile", () => {
  it("reads each public file from disk once and retries files it could not read", async () => {
    vi.resetModules();
    const reads: string[] = [];
    let failNext = true;
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        readFile: (async (path: string) => {
          reads.push(String(path));
          if (String(path).endsWith("beasts.jpg") && failNext) {
            failNext = false;
            throw new Error("EMFILE: too many open files");
          }
          return Buffer.from(JPEG);
        }) as unknown as typeof actual.readFile,
      };
    });

    try {
      const { defaultShareArtworkSources: io } = await import("./share-artwork");
      await expect(io.readPublicFile("share/banners/realms.jpg")).resolves.toEqual(JPEG);
      await expect(io.readPublicFile("share/banners/realms.jpg")).resolves.toEqual(JPEG);
      await expect(io.readPublicFile("share/banners/beasts.jpg")).resolves.toBeNull();
      await expect(io.readPublicFile("share/banners/beasts.jpg")).resolves.toEqual(JPEG);

      expect(reads.filter((path) => path.endsWith("realms.jpg"))).toHaveLength(1);
      expect(reads.filter((path) => path.endsWith("beasts.jpg"))).toHaveLength(2);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});
