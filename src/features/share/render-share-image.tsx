import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReactElement } from "react";
import { ImageResponse } from "next/og";
import { SHARE_BANNERS } from "@/lib/marketplace/collection-banners";
import type { CollectionShareData, TokenShareData } from "@/lib/marketplace/seo-data";
import { getTokenIconUrl } from "@/lib/marketplace/token-display";
import type { SharePrice } from "@/lib/seo/share-card-model";
import { loadShareArtwork } from "@/lib/seo/share-artwork";
import { CollectionShareCard } from "./collection-share-card";
import { SHARE_CARD_SIZE, shareFonts, type ShareCardImages } from "./share-card-parts";
import { SiteShareCard } from "./site-share-card";
import { TokenShareCard } from "./token-share-card";

/**
 * Server-side rendering of share images. Every image is inlined as a data URI
 * by `loadShareArtwork`, so the renderer never fetches a URL itself.
 */

const LOGO = "/rw-logo.svg";

type ShareFont = {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 600;
  style: "normal";
};

let fontsPromise: Promise<ShareFont[]> | undefined;

async function readFont(path: string) {
  const bytes = await readFile(join(process.cwd(), "public", path));
  return Uint8Array.from(bytes).buffer;
}

/**
 * Static font files; the renderer cannot parse the site's variable fonts. A
 * failed read is not kept, so the next render retries it.
 */
function loadShareFonts() {
  fontsPromise ??= Promise.all([
    readFont("brand/fonts/exo-2-400-static.ttf"),
    readFont("brand/fonts/exo-2-600-static.ttf"),
    readFont("brand/im-fell-english-sc-regular.ttf"),
  ]).then(
    ([regular, semibold, display]): ShareFont[] => [
      { name: shareFonts.ui, data: regular, weight: 400, style: "normal" },
      { name: shareFonts.ui, data: semibold, weight: 600, style: "normal" },
      { name: shareFonts.display, data: display, weight: 400, style: "normal" },
    ],
    (error: unknown) => {
      fontsPromise = undefined;
      throw error;
    },
  );
  return fontsPromise;
}

export type ShareImageOptions = {
  /** Seconds a shared cache may reuse the image. */
  maxAge: number;
};

/**
 * Renders a card to PNG. The card is rendered to a buffer before responding,
 * so a decoding failure (for example malformed artwork) falls back to the
 * `fallback` card instead of a broken image stream.
 */
export async function renderShareImage(
  card: ReactElement,
  fallback: ReactElement | null,
  { maxAge }: ShareImageOptions,
) {
  const fonts = await loadShareFonts();
  let lastError: unknown;

  for (const element of fallback ? [card, fallback] : [card]) {
    try {
      const image = new ImageResponse(element, { ...SHARE_CARD_SIZE, fonts });
      const body = await image.arrayBuffer();
      return new Response(body, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 5}`,
        },
      });
    } catch (error) {
      lastError = error;
      console.error("[share-image] render failed; trying fallback", error);
    }
  }

  throw lastError;
}

async function currencyIcon(price: SharePrice | null) {
  const icon = price ? getTokenIconUrl(price.currency) : null;
  return icon ? loadShareArtwork([icon]) : null;
}

async function loadIcons(paths: string[]) {
  const entries = await Promise.all(
    paths.map(async (path) => [path, await loadShareArtwork([path])] as const),
  );
  return Object.fromEntries(
    entries.filter((entry): entry is readonly [string, string] => entry[1] !== null),
  );
}

const withoutArtwork = (images: ShareCardImages): ShareCardImages => ({
  ...images,
  artwork: null,
});

export async function renderTokenShareImage(card: TokenShareData, options: ShareImageOptions) {
  const [artwork, logo, priceIcon, icons] = await Promise.all([
    loadShareArtwork(card.artwork),
    loadShareArtwork([LOGO]),
    currencyIcon(card.price),
    loadIcons(card.traits.items.flatMap((trait) => (trait.icon ? [trait.icon] : []))),
  ]);
  const images: ShareCardImages = { artwork, logo, currencyIcon: priceIcon, icons };

  return renderShareImage(
    <TokenShareCard card={card} images={images} />,
    <TokenShareCard card={card} images={withoutArtwork(images)} />,
    options,
  );
}

export async function renderCollectionShareImage(
  card: CollectionShareData,
  options: ShareImageOptions,
) {
  const [artwork, logo, priceIcon] = await Promise.all([
    loadShareArtwork(card.artwork),
    loadShareArtwork([LOGO]),
    currencyIcon(card.floor),
  ]);
  const images: ShareCardImages = { artwork, logo, currencyIcon: priceIcon };

  return renderShareImage(
    <CollectionShareCard card={card} images={images} />,
    <CollectionShareCard card={card} images={withoutArtwork(images)} />,
    options,
  );
}

export async function renderSiteShareImage(options: ShareImageOptions) {
  const [logo, ...banners] = await Promise.all([
    loadShareArtwork([LOGO]),
    ...SHARE_BANNERS.map((banner) => loadShareArtwork([banner])),
  ]);

  return renderShareImage(
    <SiteShareCard logo={logo} banners={banners.filter((banner): banner is string => !!banner)} />,
    <SiteShareCard logo={logo} banners={[]} />,
    options,
  );
}
