import type { CSSProperties, ReactNode } from "react";
import type { SharePrice } from "@/lib/seo/share-card-model";

export { groupDigits } from "@/lib/seo/share-card-model";

/**
 * Building blocks for 1200×630 share images. They render twice: in `next/og`
 * (Satori) for link previews, and in the browser for Storybook. Satori supports
 * a subset of CSS, so everything here uses inline flexbox styles, sets
 * `display: flex` on any element with more than one child, and avoids classes.
 */

export const SHARE_CARD_SIZE = { width: 1200, height: 630 } as const;

/** Brand tokens from `globals.css` (Realms dark theme). */
export const shareColors = {
  void: "#050709",
  smoke: "#070b0d",
  iron: "#101417",
  slate: "#161b20",
  brass: "#e7cf88",
  brassDeep: "#caa75d",
  ink: "#17110a",
  text: "#e8dcc2",
  muted: "rgba(216, 200, 168, 0.72)",
  title: "#f5ead0",
  etched: "rgba(231, 207, 136, 0.22)",
  etchedStrong: "rgba(231, 207, 136, 0.38)",
} as const;

/** Font family names registered with the renderer (see `share-image.tsx`). */
export const shareFonts = {
  display: "IM Fell English SC",
  ui: "Exo 2",
} as const;

/** Images the card draws: data URIs on the server, public URLs in Storybook. */
export type ShareCardImages = {
  artwork: string | null;
  logo: string | null;
  currencyIcon?: string | null;
  /** Keyed by the public path in the model, e.g. `/resources/coal.png`. */
  icons?: Record<string, string>;
};

const PRICE_LABELS: Record<SharePrice["kind"], string> = {
  listing: "Listed for",
  offer: "Top offer",
  sale: "Last sale",
  floor: "Floor",
};

export function priceLabel(price: SharePrice) {
  return PRICE_LABELS[price.kind];
}

/** Truncates to a character budget so text never relies on renderer clamping. */
export function fitText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}…` : value;
}

export function ShareCanvas({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        display: "flex",
        position: "relative",
        width: SHARE_CARD_SIZE.width,
        height: SHARE_CARD_SIZE.height,
        overflow: "hidden",
        backgroundColor: shareColors.void,
        color: shareColors.text,
        fontFamily: shareFonts.ui,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function VerifiedMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Verified collection"
    >
      <circle cx="12" cy="12" r="11" fill={shareColors.brass} />
      <path
        d="M7 12.5l3.2 3.2L17 9"
        fill="none"
        stroke={shareColors.ink}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark({ logo, size = 30 }: { logo: string | null; size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element -- Satori renders plain img elements only.
        <img src={logo} alt="" width={Math.round(size * 1.8)} height={size} />
      ) : null}
      <span
        style={{
          fontFamily: shareFonts.display,
          fontSize: size,
          color: shareColors.title,
          lineHeight: 1,
        }}
      >
        Realms.market
      </span>
    </div>
  );
}

function amountSize(text: string) {
  if (text.length <= 12) return 50;
  if (text.length <= 18) return 42;
  return 32;
}

/**
 * The card's one loud element. Buy-now prices (a listing or a collection
 * floor) are a solid brass plaque, like the site's buy button; offers and
 * sales use an outlined plaque.
 */
export function PricePlaque({
  price,
  currencyIcon,
  emptyLabel = "Not listed",
}: {
  price: SharePrice | null;
  currencyIcon?: string | null;
  emptyLabel?: string;
}) {
  const solid = price?.kind === "listing" || price?.kind === "floor";
  const amount = price ? fitText(`${price.display} ${price.symbol}`, 30) : emptyLabel;

  return (
    <div
      data-testid="share-price"
      style={{
        display: "flex",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: 18,
        padding: price ? "14px 28px 14px 20px" : "16px 28px",
        borderRadius: 12,
        border: `2px solid ${solid ? "rgba(245, 234, 208, 0.4)" : shareColors.etchedStrong}`,
        // Satori rejects style keys whose value is undefined, so branch whole entries.
        ...(solid
          ? {
              backgroundImage: `linear-gradient(180deg, ${shareColors.brass} 0%, ${shareColors.brassDeep} 100%)`,
            }
          : { backgroundColor: "rgba(5, 7, 9, 0.6)" }),
        color: solid ? shareColors.ink : shareColors.title,
        maxWidth: 474,
      }}
    >
      {price && currencyIcon ? (
        // eslint-disable-next-line @next/next/no-img-element -- Satori renders plain img elements only.
        <img
          src={currencyIcon}
          alt=""
          width={52}
          height={52}
          style={{ borderRadius: 26, flexShrink: 0 }}
        />
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        {price ? (
          <span
            style={{
              fontSize: 20,
              lineHeight: 1.2,
              color: solid ? "rgba(23, 17, 10, 0.78)" : shareColors.muted,
            }}
          >
            {priceLabel(price)}
          </span>
        ) : null}
        <span
          style={{
            fontSize: price ? amountSize(amount) : 32,
            fontWeight: 600,
            lineHeight: 1.1,
            color: solid ? shareColors.ink : price ? shareColors.brass : shareColors.muted,
          }}
        >
          {amount}
        </span>
      </div>
    </div>
  );
}
