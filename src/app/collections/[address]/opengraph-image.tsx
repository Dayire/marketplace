import { renderCollectionShareImage } from "@/features/share/render-share-image";
import { getCollectionShareData } from "@/lib/marketplace/seo-data";

export const alt = "Collection preview on Realms.market";

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = "image/png";

// Rendered per request, like asset cards: caching a card for every requested
// address would let arbitrary URLs grow the container's disk. The data behind
// it is cached for five minutes (seo-data.ts), and the response may be reused
// for as long by unfurlers or a CDN.
const MAX_AGE_SECONDS = 300;

export default async function Image({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  return renderCollectionShareImage(await getCollectionShareData(address), {
    maxAge: MAX_AGE_SECONDS,
  });
}
