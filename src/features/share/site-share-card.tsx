import { ShareCanvas, shareColors, shareFonts } from "./share-card-parts";

export type SiteShareCardProps = {
  /** Collection banners shown as vertical panels behind the title. */
  banners: string[];
  logo: string | null;
};

const MAX_PANELS = 6;

/** Default link preview for pages without their own card (home, portfolio, profiles). */
export function SiteShareCard({ banners, logo }: SiteShareCardProps) {
  const panels = banners.slice(0, MAX_PANELS);
  const panelWidth = Math.ceil(1200 / Math.max(panels.length, 1));

  return (
    <ShareCanvas>
      <div style={{ display: "flex", position: "absolute", top: 0, left: 0, height: 630 }}>
        {panels.map((banner, index) => (
          // eslint-disable-next-line @next/next/no-img-element -- Satori renders plain img elements only.
          <img
            key={banner}
            src={banner}
            alt=""
            width={panelWidth}
            height={630}
            style={{
              width: panelWidth,
              height: 630,
              objectFit: "cover",
              opacity: 0.7,
              ...(index === 0 ? {} : { borderLeft: `2px solid ${shareColors.void}` }),
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: "flex",
          position: "absolute",
          top: 0,
          left: 0,
          width: 1200,
          height: 630,
          backgroundImage: `linear-gradient(90deg, ${shareColors.void} 0%, rgba(5, 7, 9, 0.92) 46%, rgba(5, 7, 9, 0.35) 100%)`,
        }}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 22,
          height: 630,
          padding: "0 72px",
          maxWidth: 760,
        }}
      >
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- Satori renders plain img elements only.
          <img src={logo} alt="" width={144} height={80} />
        ) : null}
        <span
          style={{
            fontFamily: shareFonts.display,
            fontSize: 92,
            lineHeight: 1,
            color: shareColors.title,
          }}
        >
          Realms.market
        </span>
        <span style={{ fontSize: 32, lineHeight: 1.35, color: shareColors.text }}>
          The Realms ecosystem marketplace. Trade Realms, Adventurers, Beasts and
          Loot Chests on Starknet.
        </span>
      </div>
    </ShareCanvas>
  );
}
