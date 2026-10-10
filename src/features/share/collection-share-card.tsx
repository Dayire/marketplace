import type { CollectionShareData } from "@/lib/marketplace/seo-data";
import {
  fitText,
  groupDigits,
  PricePlaque,
  ShareCanvas,
  shareColors,
  shareFonts,
  VerifiedMark,
  Wordmark,
  type ShareCardImages,
} from "./share-card-parts";

export type CollectionShareCardProps = {
  card: Pick<
    CollectionShareData,
    "exists" | "name" | "description" | "verified" | "floor" | "listedCount" | "supply"
  >;
  images: ShareCardImages;
};

const BANNER_HEIGHT = 360;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 22, lineHeight: 1.2, color: shareColors.muted }}>{label}</span>
      <span
        style={{ fontSize: 40, fontWeight: 600, lineHeight: 1.1, color: shareColors.title }}
      >
        {fitText(groupDigits(value), 12)}
      </span>
    </div>
  );
}

function nameSize(name: string) {
  if (name.length <= 16) return 76;
  if (name.length <= 26) return 60;
  return 48;
}

/** Link preview for a collection: banner art, name, floor, listed count and supply. */
export function CollectionShareCard({ card, images }: CollectionShareCardProps) {
  const name = fitText(card.name, 40);

  return (
    <ShareCanvas style={{ flexDirection: "column" }}>
      {images.artwork ? (
        // eslint-disable-next-line @next/next/no-img-element -- Satori renders plain img elements only.
        <img
          src={images.artwork}
          alt=""
          width={1200}
          height={BANNER_HEIGHT}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 1200,
            height: BANNER_HEIGHT,
            objectFit: "cover",
          }}
        />
      ) : null}
      <div
        style={{
          display: "flex",
          position: "absolute",
          top: 0,
          left: 0,
          width: 1200,
          height: 630,
          backgroundImage: images.artwork
            ? `linear-gradient(180deg, rgba(5, 7, 9, 0.05) 0%, rgba(5, 7, 9, 0.5) 32%, ${shareColors.void} 56%)`
            : `radial-gradient(circle at 18% 0%, rgba(231, 207, 136, 0.16) 0%, rgba(5, 7, 9, 0) 55%)`,
        }}
      />

      <div
        style={{
          display: "flex",
          position: "absolute",
          bottom: 52,
          right: 56,
        }}
      >
        <Wordmark logo={images.logo} size={28} />
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          gap: 26,
          height: 630,
          padding: "0 56px 48px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span
              style={{
                fontFamily: shareFonts.display,
                fontSize: nameSize(name),
                lineHeight: 1.02,
                textTransform: "uppercase",
                color: shareColors.title,
              }}
            >
              {name}
            </span>
            {card.verified ? <VerifiedMark size={34} /> : null}
          </div>
          {card.description ? (
            <span style={{ fontSize: 26, lineHeight: 1.3, color: shareColors.muted }}>
              {fitText(card.description, 78)}
            </span>
          ) : null}
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", gap: 48 }}>
          <PricePlaque
            price={card.floor}
            currencyIcon={images.currencyIcon}
            emptyLabel={card.exists ? "No listings" : "Unavailable"}
          />
          {card.listedCount ? <Stat label="Listed" value={card.listedCount} /> : null}
          {card.supply ? <Stat label="Items" value={card.supply} /> : null}
        </div>
      </div>
    </ShareCanvas>
  );
}
