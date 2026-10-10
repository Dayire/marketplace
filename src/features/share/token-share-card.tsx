import type { TokenShareData } from "@/lib/marketplace/seo-data";
import type { ShareTrait } from "@/lib/seo/share-card-model";
import {
  fitText,
  PricePlaque,
  ShareCanvas,
  shareColors,
  shareFonts,
  VerifiedMark,
  Wordmark,
  type ShareCardImages,
} from "./share-card-parts";

export type TokenShareCardProps = {
  card: Pick<
    TokenShareData,
    "exists" | "tokenName" | "collectionName" | "verified" | "price" | "traits"
  >;
  images: ShareCardImages;
};

const ART_SIZE = 630;
const PANEL_WIDTH = 1200 - ART_SIZE;
const PANEL_PADDING_X = 48;
const CONTENT_WIDTH = PANEL_WIDTH - PANEL_PADDING_X * 2;
const TRAIT_GAP = 18;

/**
 * The display face averages about 0.7em per uppercase character, so pick the
 * largest size that keeps the name to two lines (one line at the largest).
 */
function nameStyle(name: string) {
  if (name.length <= 10) return { size: 66, text: name };
  if (name.length <= 12) return { size: 56, text: name };
  if (name.length <= 24) return { size: 48, text: name };
  return { size: 40, text: fitText(name, 28) };
}

function TraitCell({ trait, icon }: { trait: ShareTrait; icon?: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: (CONTENT_WIDTH - TRAIT_GAP) / 2,
        minHeight: icon ? 44 : 50,
      }}
    >
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element -- Satori renders plain img elements only.
        <img src={icon} alt="" width={44} height={44} style={{ flexShrink: 0 }} />
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        {icon ? null : (
          <span style={{ fontSize: 18, lineHeight: 1.2, color: shareColors.muted }}>
            {fitText(trait.label, 20)}
          </span>
        )}
        <span
          style={{
            fontSize: 24,
            fontWeight: 600,
            lineHeight: 1.2,
            color: shareColors.text,
          }}
        >
          {fitText(trait.value, 17)}
        </span>
      </div>
    </div>
  );
}

/** Link preview for an asset: artwork, identity, up to seven traits and its price. */
export function TokenShareCard({ card, images }: TokenShareCardProps) {
  const name = nameStyle(card.tokenName);
  const resources = card.traits.layout === "resources";

  return (
    <ShareCanvas>
      <div
        style={{
          display: "flex",
          position: "relative",
          width: ART_SIZE,
          height: ART_SIZE,
          flexShrink: 0,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0b0f12",
          backgroundImage:
            "radial-gradient(circle at 50% 42%, rgba(231, 207, 136, 0.18) 0%, rgba(11, 15, 18, 0) 62%)",
          borderRight: `2px solid ${shareColors.etchedStrong}`,
        }}
      >
        {images.artwork ? (
          // eslint-disable-next-line @next/next/no-img-element -- Satori renders plain img elements only.
          <img
            src={images.artwork}
            alt=""
            width={ART_SIZE}
            height={ART_SIZE}
            style={{ width: ART_SIZE, height: ART_SIZE, objectFit: "contain" }}
          />
        ) : (
          <span
            style={{
              fontFamily: shareFonts.display,
              fontSize: 40,
              color: shareColors.muted,
            }}
          >
            Artwork unavailable
          </span>
        )}
        <div
          style={{
            display: "flex",
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 112,
            alignItems: "flex-end",
            padding: "0 32px 26px",
            backgroundImage:
              "linear-gradient(180deg, rgba(5, 7, 9, 0) 0%, rgba(5, 7, 9, 0.88) 78%)",
          }}
        >
          <Wordmark logo={images.logo} size={28} />
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: PANEL_WIDTH,
          flexShrink: 0,
          padding: `44px ${PANEL_PADDING_X}px`,
          backgroundImage: `radial-gradient(circle at 100% 0%, rgba(231, 207, 136, 0.12) 0%, rgba(16, 20, 23, 0) 46%), linear-gradient(160deg, ${shareColors.iron} 0%, ${shareColors.smoke} 100%)`,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: CONTENT_WIDTH }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                fontSize: 27,
                fontWeight: 600,
                lineHeight: 1.2,
                color: shareColors.brass,
              }}
            >
              {fitText(card.collectionName, 30)}
            </span>
            {card.verified ? <VerifiedMark size={24} /> : null}
          </div>
          <span
            style={{
              fontFamily: shareFonts.display,
              fontSize: name.size,
              lineHeight: 1.04,
              textTransform: "uppercase",
              color: shareColors.title,
            }}
          >
            {name.text}
          </span>
        </div>

        {card.traits.items.length > 0 ? (
          <div
            data-testid="share-traits"
            style={{
              display: "flex",
              flexWrap: "wrap",
              width: CONTENT_WIDTH,
              columnGap: TRAIT_GAP,
              rowGap: 8,
            }}
          >
            {card.traits.items.map((trait, index) => (
              <TraitCell
                key={`${trait.label}-${trait.value}-${index}`}
                trait={trait}
                icon={resources && trait.icon ? images.icons?.[trait.icon] : undefined}
              />
            ))}
          </div>
        ) : null}

        <PricePlaque
          price={card.price}
          currencyIcon={images.currencyIcon}
          emptyLabel={card.exists ? "Not listed" : "Unavailable"}
        />
      </div>
    </ShareCanvas>
  );
}
