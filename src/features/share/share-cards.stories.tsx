import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { expect } from "storybook/test";
import type { SharePrice, ShareTraitSummary } from "@/lib/seo/share-card-model";
import { CollectionShareCard } from "./collection-share-card";
import { SHARE_CARD_SIZE, shareFonts, type ShareCardImages } from "./share-card-parts";
import { SiteShareCard } from "./site-share-card";
import { TokenShareCard, type TokenShareCardProps } from "./token-share-card";

/**
 * Link previews rendered by `next/og` for Discord, X, Telegram and other
 * unfurlers. Storybook draws the same components in the browser with the same
 * static fonts; `pnpm test` also renders each state through the real renderer.
 */

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const LORDS = "0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49";

/** Scales the fixed 1200×630 card to the available width, as unfurlers do. */
function ScaledPreview({ children, label }: { children: ReactNode; label: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setScale(Math.min(1, entry.contentRect.width / SHARE_CARD_SIZE.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <figure className="m-0 w-full max-w-[1200px] space-y-2">
      <div
        ref={frame}
        role="img"
        aria-label={label}
        className="relative w-full overflow-hidden rounded-md border border-[color:var(--realm-border-etched)]"
        style={{ aspectRatio: `${SHARE_CARD_SIZE.width} / ${SHARE_CARD_SIZE.height}` }}
      >
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          {children}
        </div>
      </div>
      <figcaption className="text-xs text-muted-foreground">
        1200×630 link preview, shown at {Math.round(scale * 100)}%
      </figcaption>
    </figure>
  );
}

/** Registers the static instances the server renderer uses. */
function ShareFonts() {
  return (
    <style>{`
      @font-face { font-family: "${shareFonts.ui}"; src: url("/brand/fonts/exo-2-400-static.ttf") format("truetype"); font-weight: 400; }
      @font-face { font-family: "${shareFonts.ui}"; src: url("/brand/fonts/exo-2-600-static.ttf") format("truetype"); font-weight: 600; }
    `}</style>
  );
}

const images: ShareCardImages = {
  artwork: "/share/banners/realms.jpg",
  logo: "/rw-logo.svg",
  currencyIcon: "/tokens/strk.svg",
  icons: Object.fromEntries(
    ["dragonhide", "mithral", "coal", "gold", "wood", "stone", "copper"].map((name) => [
      `/resources/${name}.png`,
      `/resources/${name}.png`,
    ]),
  ),
};

const strk = (display: string, kind: SharePrice["kind"] = "listing"): SharePrice => ({
  kind,
  amount: "0",
  currency: STRK,
  symbol: "STRK",
  display,
});

const realmResources: ShareTraitSummary = {
  layout: "resources",
  items: ["Dragonhide", "Mithral", "Coal", "Gold", "Wood", "Stone", "Copper"].map((value) => ({
    label: "Resource",
    value,
    icon: `/resources/${value.toLowerCase()}.png`,
  })),
};

const list = (...pairs: Array<[string, string]>): ShareTraitSummary => ({
  layout: "list",
  items: pairs.map(([label, value]) => ({ label, value })),
});

function TokenPreview(props: TokenShareCardProps) {
  return (
    <ScaledPreview label={`Link preview for ${props.card.tokenName}`}>
      <ShareFonts />
      <TokenShareCard {...props} />
    </ScaledPreview>
  );
}

const meta = {
  title: "Share/Link previews",
  component: TokenPreview,
  parameters: { layout: "padded" },
  args: {
    card: {
      exists: true,
      tokenName: "Stolsli",
      collectionName: "Realms",
      verified: true,
      price: strk("27.16"),
      traits: realmResources,
    },
    images,
  },
} satisfies Meta<typeof TokenPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ListedRealm: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("img", { name: "Link preview for Stolsli" })).toBeVisible();
    await expect(canvas.getByTestId("share-price")).toHaveTextContent("Listed for27.16 STRK");
    await expect(canvas.getByTestId("share-traits").children).toHaveLength(7);
    await expect(canvas.getByText("Dragonhide")).toBeInTheDocument();
  },
};

export const TopOfferInLords: Story = {
  args: {
    card: {
      exists: true,
      tokenName: '"Grim Shout" Warlock',
      collectionName: "Beasts",
      verified: false,
      price: { kind: "offer", amount: "0", currency: LORDS, symbol: "LORDS", display: "1085.4" },
      traits: list(
        ["Beast", "Warlock"],
        ["Type", "Magic"],
        ["Tier", "1"],
        ["Level", "42"],
        ["Power", "1023"],
        ["Health", "880"],
        ["Prefix", "Grim"],
      ),
    },
    images: { ...images, artwork: "/share/banners/beasts.jpg", currencyIcon: "/tokens/lords.png" },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("share-price")).toHaveTextContent("Top offer1085.4 LORDS");
    await expect(canvas.queryByLabelText("Verified collection")).toBeNull();
  },
};

export const LastSale: Story = {
  args: {
    card: {
      exists: true,
      tokenName: "Adventurer #8812",
      collectionName: "Adventurers",
      verified: true,
      price: strk("0.000000000000000001", "sale"),
      traits: list(["Level", "17"], ["Health", "212"], ["Archetype", "Warrior"]),
    },
    images: { ...images, artwork: "/share/banners/adventurers.jpg" },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("share-price")).toHaveTextContent("Last sale");
  },
};

export const CosmeticNotListed: Story = {
  args: {
    card: {
      exists: true,
      tokenName: "Cosmetic Armour of the Twilight Quartz Forest Reborn Edition",
      collectionName: "Cosmetics",
      verified: true,
      price: null,
      traits: list(["Epoch", "2"], ["Rarity", "Legendary"], ["Type", "Armor"]),
    },
    images: { ...images, artwork: "/placeholders/s0-chest.svg", currencyIcon: null },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("share-price")).toHaveTextContent("Not listed");
    await expect(canvas.getByText(/…$/)).toBeInTheDocument();
  },
};

export const LootChest: Story = {
  args: {
    card: {
      exists: true,
      tokenName: "Blitz Chest #2357",
      collectionName: "Loot Chests",
      verified: true,
      price: strk("12.5"),
      traits: list(["Epoch", "3"], ["ID", "#2357"]),
    },
    images: { ...images, artwork: "/placeholders/blitz-chest.svg" },
  },
};

export const GoldenToken: Story = {
  args: {
    card: {
      exists: true,
      tokenName: "Golden Token #1120",
      collectionName: "Golden Token",
      verified: true,
      price: strk("150"),
      traits: list(["Item", "#1120"]),
    },
    images: { ...images, artwork: "/share/banners/golden-token.jpg" },
  },
};

export const Unavailable: Story = {
  args: {
    card: {
      exists: false,
      tokenName: "Token #999",
      collectionName: "Realms",
      verified: true,
      price: null,
      traits: { layout: "list", items: [] },
    },
    images: { ...images, artwork: null },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Artwork unavailable")).toBeInTheDocument();
    await expect(canvas.getByTestId("share-price")).toHaveTextContent("Unavailable");
  },
};

export const Collection: Story = {
  render: () => (
    <ScaledPreview label="Link preview for Adventurers">
      <ShareFonts />
      <CollectionShareCard
        card={{
          exists: true,
          name: "Adventurers",
          description:
            "Every adventurer who entered the Loot Survivor dungeon, with their gear and stats.",
          verified: true,
          floor: strk("22.22", "floor"),
          listedCount: "412",
          supply: "18000",
        }}
        images={{ ...images, artwork: "/share/banners/adventurers.jpg" }}
      />
    </ScaledPreview>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("share-price")).toHaveTextContent("Floor22.22 STRK");
    await expect(canvas.getByText("18,000")).toBeInTheDocument();
  },
};

export const CollectionWithoutListings: Story = {
  render: () => (
    <ScaledPreview label="Link preview for Season Pass">
      <ShareFonts />
      <CollectionShareCard
        card={{
          exists: true,
          name: "Season Pass",
          description: null,
          verified: false,
          floor: null,
          listedCount: "0",
          supply: "1200",
        }}
        images={{ ...images, artwork: null }}
      />
    </ScaledPreview>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("share-price")).toHaveTextContent("No listings");
  },
};

export const SiteDefault: Story = {
  render: () => (
    <ScaledPreview label="Default Realms.market link preview">
      <ShareFonts />
      <SiteShareCard
        logo="/rw-logo.svg"
        banners={["realms", "adventurers", "beasts", "loot-chests", "golden-token"].map(
          (name) => `/share/banners/${name}.jpg`,
        )}
      />
    </ScaledPreview>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("img", { name: "Default Realms.market link preview" })).toBeVisible();
  },
};
