"use client";
import {
  TokenDetailSkeleton,
  ListSkeleton,
} from "@/components/marketplace/loading-state";

import { useId, useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { prepareCancellation } from "@biblio/marketplace";
import { TokenMedia } from "@/components/marketplace/token-media";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAddToCartFeedback } from "@/features/cart/hooks/use-add-to-cart-feedback";
import {
  cartItemFromTokenListing,
  cheapestListingByTokenId,
} from "@/features/cart/listing-utils";
import { useCartStore } from "@/features/cart/store/cart-store";
import {
  ListingSharePrompt,
  isSharePromptDismissed,
  rememberSharePromptDismissed,
} from "@/features/share/listing-share-prompt";
import { assetShareText } from "@/features/share/share-links";
import { ShareMenu } from "@/features/share/share-menu";
import { AcceptOffer } from "@/features/trading/accept-offer";
import { BestBid } from "@/features/trading/best-bid";
import { OrderComposer } from "@/features/trading/order-composer";
import { ReportToken } from "@/features/trading/report-token";
import { normalizeMarketplaceAddress } from "@/lib/marketplace/address";
import { formatCurrencyAmount } from "@/lib/marketplace/amount-display";
import { marketplaceRequest } from "@/lib/marketplace/api-client";
import { getMarketplaceRuntimeConfig } from "@/lib/marketplace/config";
import {
  useCollectionListingsQuery,
  useCollectionQuery,
  useTokenDetailQuery,
} from "@/lib/marketplace/hooks";
import { useCollectionOffersQuery } from "@/lib/marketplace/market-data";
import {
  displayTokenId,
  formatAddress,
  getTokenSymbol,
  tokenMediaSources,
  tokenName,
} from "@/lib/marketplace/token-display";
import type { ApiPage } from "@/lib/marketplace/types";
import { useTrade } from "@/lib/marketplace/use-trade";
import { toAbsoluteUrl } from "@/lib/seo/site-url";
import { ListingPurchase } from "./listing-purchase";
import { OfferList } from "./offer-list";
import { TokenActivity, type TokenActivityItem } from "./token-activity";
import {
  pickLastSale,
  pickTopOffer,
  TokenMarketSummary,
} from "./token-market-summary";
import { TraitGrid, traitAttributesFromMetadata } from "./trait-grid";
import { useTokenOwnership } from "./use-token-ownership";
import { useTraitRarity } from "./use-trait-rarity";

type ComposerKind = "listing" | "token_offer";

function sameAddress(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  if (!left || !right) return false;
  return (
    normalizeMarketplaceAddress(left) === normalizeMarketplaceAddress(right)
  );
}

function sameTokenId(left: string, right: string) {
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return left === right;
  }
}

function seedCollectionName(address: string) {
  const target = normalizeMarketplaceAddress(address);
  return getMarketplaceRuntimeConfig().collections.find(
    (collection) => normalizeMarketplaceAddress(collection.address) === target,
  )?.name;
}

function displayPrice(amount: string, currency: string) {
  return `${formatCurrencyAmount(amount, currency)} ${getTokenSymbol(currency)}`;
}

const focusRing =
  "rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function TokenDetailView({
  address,
  tokenId,
  projectId,
}: {
  address: string;
  tokenId: string;
  projectId?: string;
}) {
  const detail = useTokenDetailQuery({
    collection: address,
    tokenId,
    projectId,
    fetchImages: true,
  });
  const collection = useCollectionQuery({ address, projectId });
  const listings = useCollectionListingsQuery({
    collection: address,
    tokenId,
    projectId,
  });
  const trade = useTrade();
  const ownership = useTokenOwnership({
    collection: address,
    tokenId,
    walletAddress: trade.address,
    isConnected: !!trade.address,
  });
  const rarity = useTraitRarity(address);
  const cartItems = useCartStore((s) => s.items);
  const setCartOpen = useCartStore((s) => s.setOpen);
  const { addListingToCart } = useAddToCartFeedback();
  const offers = useCollectionOffersQuery(address, {
    tokenMatch: tokenId,
    limit: 50,
  });
  const activity = useInfiniteQuery<ApiPage<TokenActivityItem>>({
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    queryKey: ["owned", "activity", address, tokenId],
    queryFn: ({ pageParam }) =>
      marketplaceRequest<ApiPage<TokenActivityItem>>(
        `/tokens/${address}/${tokenId}/activity`,
        { limit: 20, cursor: pageParam },
      ),
  });
  const [composer, setComposer] = useState<ComposerKind | null>(null);
  const [dismissedShareFor, setDismissedShareFor] = useState<string | null>(null);
  const composerId = useId();

  const offerItems = (
    offers.data?.pages.flatMap((page) => page.items) ?? []
  ).filter(
    (order) =>
      order.kind !== "listing" &&
      (order.tokenId == null || sameTokenId(order.tokenId, tokenId)),
  );
  const activityItems =
    activity.data?.pages.flatMap((page) => page.items) ?? [];

  if (detail.isLoading) return <TokenDetailSkeleton />;
  if (detail.isError || !detail.data?.token)
    return (
      <Card>
        <CardContent className="space-y-3 p-8">
          <p role="alert">Unable to load this token.</p>
          <Button className="min-h-11" onClick={() => void detail.refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );

  const token = detail.data.token;
  const name = tokenName(token);
  const metadata = token.metadata as { description?: unknown } | null;
  const description =
    typeof metadata?.description === "string" && metadata.description.trim()
      ? metadata.description
      : null;
  const attributes = traitAttributesFromMetadata(token.metadata);
  const collectionName =
    collection.data?.metadata?.name ??
    seedCollectionName(address) ??
    formatAddress(address);

  const tokenListings = listings.data ?? [];
  const cheapest = cheapestListingByTokenId(tokenListings).get(
    BigInt(tokenId).toString(),
  );
  const myListing = tokenListings.find((listing) =>
    sameAddress(listing.owner, trade.address),
  );
  const isOwner = ownership.effectiveIsOwner;
  const owner =
    ownership.holderAddress ?? (isOwner ? (trade.address ?? null) : null);

  // Like the link preview, only price the share text from the holder's own
  // listings; a previous owner's listing can linger in the index.
  const holder = ownership.holderAddress;
  const shareListing = holder
    ? cheapestListingByTokenId(
        tokenListings.filter((listing) => sameAddress(listing.owner, holder)),
      ).get(BigInt(tokenId).toString())
    : cheapest;
  const shareTarget = {
    url: toAbsoluteUrl(`/collections/${address}/${tokenId}`),
    title: `${name} | ${collectionName} | Realms.market`,
    text: assetShareText({
      name,
      price: shareListing
        ? displayPrice(shareListing.price, shareListing.currency)
        : null,
    }),
  };
  // Listings come from the index, so an owner's listing here is already
  // reflected; the link preview picks up its price once its cache refreshes.
  const sharePrompt =
    isOwner &&
    myListing &&
    dismissedShareFor !== myListing.id &&
    !isSharePromptDismissed(myListing.id)
      ? myListing
      : null;

  const toggleComposer = (kind: ComposerKind) =>
    setComposer((current) => (current === kind ? null : kind));

  return (
    <div className="mx-auto max-w-7xl space-y-6" data-testid="token-detail">
      <header className="space-y-3">
        <nav aria-label="Breadcrumb" className="text-sm">
          <Link
            href={`/collections/${address}`}
            className={`inline-flex min-h-11 items-center gap-1 text-muted-foreground transition-colors hover:text-foreground ${focusRing}`}
          >
            <ChevronLeft aria-hidden className="size-4" />
            <span>{collectionName}</span>
          </Link>
        </nav>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-3xl leading-tight sm:text-4xl">{name}</h1>
          <Badge variant="outline" className="font-mono text-xs">
            #{displayTokenId(token)}
          </Badge>
          <Badge variant="outline">ERC-721</Badge>
          <ShareMenu target={shareTarget} className="sm:ml-auto" />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="realm-kicker text-xs">Owner</span>
          {owner ? (
            <Link
              href={`/profile/${owner}`}
              title={owner}
              className={`inline-flex min-h-11 items-center font-mono text-foreground underline-offset-4 hover:underline ${focusRing}`}
            >
              {formatAddress(owner)}
            </Link>
          ) : (
            <span className="inline-flex min-h-11 items-center text-muted-foreground">
              Not indexed
            </span>
          )}
          {owner && isOwner ? <Badge variant="secondary">You</Badge> : null}
        </div>
        {description ? (
          <p className="max-w-prose text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="realm-panel relative aspect-square overflow-hidden">
          <TokenMedia
            sources={tokenMediaSources(token)}
            alt={name}
            priority
            className="object-contain"
            fallbackLabel="Artwork unavailable"
            sizes="(min-width: 1024px) 50vw, 100vw"
          />
        </div>
        <div className="space-y-4">
          <TokenMarketSummary
            priceLoading={listings.isPending}
            offersLoading={offers.isPending}
            activityLoading={activity.isPending}
            price={cheapest?.price}
            currency={cheapest?.currency}
            topOffer={pickTopOffer(offerItems, cheapest?.currency)}
            lastSale={pickLastSale(activityItems)}
            listedCount={tokenListings.length}
          />
          <Card className="gap-0 border-[color:var(--realm-border-etched)] py-0">
            <CardContent className="p-5">
              {listings.isError ? (
                <p role="alert" className="flex flex-wrap items-center gap-3">
                  <span>Listing prices are unavailable.</span>
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={() => void listings.refetch()}
                  >
                    Retry
                  </Button>
                </p>
              ) : listings.isPending ? (
                <ListSkeleton label="Loading price" count={1} />
              ) : (
                <ListingPurchase
                  price={cheapest?.price}
                  currency={cheapest?.currency}
                  inCart={
                    !!cheapest &&
                    cartItems.some((item) => item.orderId === cheapest.orderId)
                  }
                  isOwner={isOwner}
                  onViewCart={() => setCartOpen(true)}
                  onAdd={() => {
                    if (cheapest)
                      addListingToCart(
                        cartItemFromTokenListing(token, address, cheapest),
                      );
                  }}
                />
              )}
            </CardContent>
          </Card>
          <div className="space-y-3">
            {sharePrompt ? (
              <ListingSharePrompt
                target={shareTarget}
                price={displayPrice(sharePrompt.price, sharePrompt.currency)}
                onDismiss={() => {
                  rememberSharePromptDismissed(sharePrompt.id);
                  setDismissedShareFor(sharePrompt.id);
                }}
              />
            ) : null}
            <div className="flex flex-wrap gap-2">
              {isOwner ? (
                <>
                  <Button
                    className="min-h-11 flex-1 sm:flex-none"
                    variant={composer === "listing" ? "outline" : "default"}
                    aria-expanded={composer === "listing"}
                    aria-controls={composerId}
                    onClick={() => toggleComposer("listing")}
                  >
                    {composer === "listing" ? "Close" : "List for sale"}
                  </Button>
                  {myListing ? (
                    <Button
                      variant="destructive"
                      className="min-h-11 flex-1 sm:flex-none"
                      disabled={trade.busy}
                      onClick={() =>
                        void trade.execute(
                          (marketplace) =>
                            prepareCancellation(
                              {
                                marketplace,
                                chain: trade.config!.chain,
                                account: trade.address!,
                              },
                              [myListing.id],
                            ),
                          "cancel",
                        )
                      }
                    >
                      Cancel listing
                    </Button>
                  ) : null}
                </>
              ) : (
                <Button
                  className="min-h-11 flex-1 sm:flex-none"
                  variant={composer === "token_offer" ? "outline" : "default"}
                  aria-expanded={composer === "token_offer"}
                  aria-controls={composerId}
                  onClick={() => toggleComposer("token_offer")}
                >
                  {composer === "token_offer" ? "Close" : "Make offer"}
                </Button>
              )}
            </div>
            {composer ? (
              <div id={composerId} className="realm-panel p-4 sm:p-5">
                <OrderComposer
                  collection={address}
                  tokenIds={[tokenId]}
                  kind={composer}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <Card className="gap-0 border-[color:var(--realm-border-etched)]">
        <CardHeader className="border-b pb-4">
          <div className="flex items-center gap-2">
            <CardTitle>Traits</CardTitle>
            {attributes.length > 0 ? (
              <Badge variant="secondary" className="tabular-nums">
                {attributes.length}
              </Badge>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          <TraitGrid
            attributes={attributes}
            rarity={rarity}
            collectionAddress={address}
          />
        </CardContent>
      </Card>

      <OfferList
        orders={offerItems}
        loading={offers.isPending}
        error={offers.isError}
        hasMore={offers.hasNextPage}
        loadingMore={offers.isFetchingNextPage}
        onRetry={() => void offers.refetch()}
        onMore={() => void offers.fetchNextPage()}
        renderAction={
          isOwner
            ? (order) => <AcceptOffer order={order} tokenId={tokenId} />
            : undefined
        }
      >
        <BestBid collection={address} tokenId={tokenId} isOwner={isOwner} />
      </OfferList>

      <Card className="gap-0 border-[color:var(--realm-border-etched)]">
        <CardHeader className="border-b pb-4">
          <CardTitle>Activity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-1">
          {activityItems.length ? (
            <TokenActivity
              items={activityItems}
              chain={getMarketplaceRuntimeConfig().chainLabel}
            />
          ) : activity.isPending ? (
            <ListSkeleton label="Loading activity" compact />
          ) : (
            <p className="pt-3 text-sm text-muted-foreground">
              {activity.isError
                ? "Activity is unavailable. Try again shortly."
                : "No indexed activity yet."}
            </p>
          )}
          {activity.hasNextPage ? (
            <Button
              variant="outline"
              className="min-h-11 w-full sm:w-auto"
              disabled={activity.isFetchingNextPage}
              onClick={() => void activity.fetchNextPage()}
            >
              More activity
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <ReportToken collection={address} tokenId={tokenId} />
    </div>
  );
}
