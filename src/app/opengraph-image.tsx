import { renderSiteShareImage } from "@/features/share/render-share-image";

export const alt = "Realms.market, the Realms ecosystem marketplace";

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = "image/png";

/** Default link preview for pages without their own card. Rendered at build time. */
export default async function Image() {
  return renderSiteShareImage({ maxAge: 3600 });
}
