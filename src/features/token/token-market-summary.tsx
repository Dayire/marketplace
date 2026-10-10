"use client";

import { Skeleton } from "@/components/ui/skeleton";
import type { ReactNode } from "react";
import { InfoTip } from "@/components/marketplace/info-tip";
import { MarketPrice } from "@/components/marketplace/market-price";
import type { MarketAmount } from "@/lib/marketplace/market-figures";

export type { MarketAmount } from "@/lib/marketplace/market-figures";
export { pickLastSale, pickTopOffer } from "@/lib/marketplace/market-figures";

export type TokenMarketSummaryProps = {
  /** Cheapest open listing in base units, including fees. */
  price?: string | null;
  currency?: string | null;
  topOffer?: MarketAmount | null;
  lastSale?: MarketAmount | null;
  /** Open listings for this token; mentioned when more than one is live. */
  listedCount?: number;
  priceLoading?: boolean;
  offersLoading?: boolean;
  activityLoading?: boolean;
};

const HELP = {
  price:
    "The cheapest open listing for this token. It includes marketplace fees and royalties; network fees are separate.",
  topOffer:
    "The highest open offer for this token or its collection. Funds stay in the bidder's wallet and are checked again when the owner accepts.",
  lastSale: "The most recent sale of this token filled on this marketplace.",
} as const;

function Tile({
  label,
  help,
  testId,
  children,
  note,
}: {
  label: string;
  help: string;
  testId: string;
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="realm-stat-pill min-w-0 px-3 py-2.5">
      <dt className="flex items-center gap-1 text-xs text-muted-foreground">
        <span>{label}</span>
        <InfoTip label={`About ${label.toLowerCase()}`} text={help} />
      </dt>
      <dd
        data-testid={testId}
        className="mt-1 min-w-0 text-lg font-semibold leading-tight text-primary"
      >
        {children}
      </dd>
      {note ? (
        <dd className="mt-0.5 text-[11px] text-muted-foreground">{note}</dd>
      ) : null}
    </div>
  );
}

/** Three at-a-glance market figures for one token. Tiles wrap on narrow screens. */
export function TokenMarketSummary({
  price,
  currency,
  topOffer,
  lastSale,
  listedCount,
  priceLoading = false,
  offersLoading = false,
  activityLoading = false,
}: TokenMarketSummaryProps) {
  return (
    <dl
      data-testid="token-market-summary"
      className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2"
    >
      <Tile
        label="Price"
        help={HELP.price}
        testId="market-summary-price"
        note={
          listedCount !== undefined && listedCount > 1
            ? `${listedCount} open listings`
            : undefined
        }
      >
        {priceLoading ? (
          <span role="status" aria-label="Loading price">
            <Skeleton className="h-6 w-24" />
          </span>
        ) : (
          <MarketPrice amount={price} currency={currency} empty="Not listed" />
        )}
      </Tile>
      <Tile
        label="Top offer"
        help={HELP.topOffer}
        testId="market-summary-top-offer"
      >
        {offersLoading ? (
          <span role="status" aria-label="Loading top offer">
            <Skeleton className="h-6 w-24" />
          </span>
        ) : (
          <MarketPrice
            amount={topOffer?.amount}
            currency={topOffer?.currency}
            empty="No offers"
          />
        )}
      </Tile>
      <Tile
        label="Last sale"
        help={HELP.lastSale}
        testId="market-summary-last-sale"
      >
        {activityLoading ? (
          <span role="status" aria-label="Loading last sale">
            <Skeleton className="h-6 w-24" />
          </span>
        ) : (
          <MarketPrice
            amount={lastSale?.amount}
            currency={lastSale?.currency}
            empty="No sales yet"
          />
        )}
      </Tile>
    </dl>
  );
}
