import { renderTokenShareImage } from "@/features/share/render-share-image";
import { getTokenShareData } from "@/lib/marketplace/seo-data";

export const alt = "Asset preview on Realms.market";

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = "image/png";

// Rendered per request rather than kept in Next's cache: there is one card per
// asset (or per arbitrary requested URL) and each PNG can approach 1 MB, so
// caching them would grow the container's disk without bound. The data behind it
// is cached for a minute (seo-data.ts), and the response may be reused for a
// minute by unfurlers or a CDN. Page metadata adds a content version to the
// URL so a price change yields a new image URL.
const MAX_AGE_SECONDS = 60;

export default async function Image({
  params,
}: {
  params: Promise<{ address: string; tokenId: string }>;
}) {
  const { address, tokenId } = await params;
  return renderTokenShareImage(await getTokenShareData(address, tokenId), {
    maxAge: MAX_AGE_SECONDS,
  });
}
