"use client";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { marketplaceRequest } from "@/lib/marketplace/api-client";
import { sameCurrency, useMarketCurrency } from "@/lib/marketplace/currency-store";
import { getMarketplaceRuntimeConfig } from "@/lib/marketplace/config";
import type { ApiCollection } from "@/lib/marketplace/types";
import type {
  CollectionCardData,
  FeaturedCollection,
  TrendingToken,
} from "./types";
import { getCollectionImage } from "@/lib/marketplace/collection-banners";
import { formatCurrencyAmount } from "@/lib/marketplace/amount-display";

function normalizeAddress(address: string) {
  try {
    return `0x${BigInt(address).toString(16)}`;
  } catch {
    return address.toLowerCase();
  }
}

/**
 * Orders indexed collections the way the marketplace is configured
 * (NEXT_PUBLIC_MARKETPLACE_COLLECTIONS), so the launch collection leads and
 * the rest keep a stable, deliberate order instead of the API's address sort.
 */
export function orderCollections<T extends { address: string }>(
  collections: T[],
  configured: Array<{ address: string }>,
): T[] {
  const rank = new Map(configured.map((entry, index) => [normalizeAddress(entry.address), index]));
  return [...collections].sort((a, b) => {
    const left = rank.get(normalizeAddress(a.address)) ?? Number.MAX_SAFE_INTEGER;
    const right = rank.get(normalizeAddress(b.address)) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}

export function useHomePageData() {
  const currency = useMarketCurrency((s) => s.currency);
  const query = useQuery({
    queryKey: ["owned", "collections"],
    queryFn: () => marketplaceRequest<ApiCollection[]>("/collections"),
    staleTime: 30_000,
  });
  const configured = getMarketplaceRuntimeConfig().collections;
  const collectionCards = useMemo<CollectionCardData[]>(
    () =>
      orderCollections(query.data ?? [], configured).map((c) => {
        const floor = c.floorByCurrency.find((f) => sameCurrency(f.currency, currency));
        return {
          address: c.address,
          name: c.name,
          imageUrl: c.image ?? getCollectionImage(c.name),
          floorPrice: floor ? formatCurrencyAmount(floor.price, currency) : null,
          floorRaw: floor?.price ?? null,
          floorCurrency: currency,
          totalSupply: c.tokenCount,
          listingCount: c.listingCount,
          verified: c.verified ?? false,
        };
      }),
    [query.data, configured, currency],
  );
  return {
    featuredCollection: (collectionCards[0] ??
      null) as FeaturedCollection | null,
    collectionCards,
    trendingTokens: [] as TrendingToken[],
    isLoading: query.isPending,
    isError: query.isError,
    refetch: query.refetch,
  };
}
