import type { Metadata } from "next";
import { toAbsoluteUrl } from "@/lib/seo/site-url";

export type MarketplaceShareImage = {
  url: string;
  width: number;
  height: number;
  alt: string;
};

type BuildMetadataOptions = {
  title: string;
  /** Title for link previews when it should differ from the document title. */
  socialTitle?: string;
  description: string;
  pathname: string;
  image: string | MarketplaceShareImage;
  noIndex?: boolean;
};

function resolveImageUrl(image: string) {
  if (/^https?:\/\//i.test(image)) {
    return image;
  }

  return toAbsoluteUrl(image);
}

/** A generated 1200×630 PNG share card for a path, versioned by its content. */
export function shareCardImage(
  pathname: string,
  version: string,
  alt: string,
): MarketplaceShareImage {
  return {
    url: `${pathname.replace(/\/$/, "")}/opengraph-image?v=${encodeURIComponent(version)}`,
    width: 1200,
    height: 630,
    alt,
  };
}

export function buildMarketplacePageMetadata({
  title,
  socialTitle = title,
  description,
  pathname,
  image,
  noIndex = false,
}: BuildMetadataOptions): Metadata {
  const canonical = toAbsoluteUrl(pathname);
  const images =
    typeof image === "string"
      ? [resolveImageUrl(image)]
      : [{ ...image, url: resolveImageUrl(image.url), type: "image/png" }];

  return {
    title,
    description,
    alternates: {
      canonical,
    },
    openGraph: {
      title: socialTitle,
      description,
      type: "website",
      url: canonical,
      siteName: "Realms.market",
      images,
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description,
      images,
    },
    robots: {
      index: !noIndex,
      follow: !noIndex,
    },
  };
}
