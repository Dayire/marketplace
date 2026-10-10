import { CollectionPageSkeleton } from "@/components/marketplace/loading-state";
import { Suspense } from "react";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import type { Metadata } from "next";
import { CollectionRouteContainer } from "@/features/collections/collection-route-container";
import { getMarketplaceRuntimeConfig } from "@/lib/marketplace/config";
import { prefetchTraitNamesSummary } from "@/lib/marketplace/trait-summary-prefetch";
import { makeQueryClient } from "@/lib/marketplace/query-client";
import { buildMarketplacePageMetadata, shareCardImage } from "@/lib/seo/metadata";
import { collectionShareCopy } from "@/lib/seo/share-copy";

type CollectionPageProps = {
  params: Promise<{ address: string }>;
  searchParams: Promise<{ cursor?: string }>;
};

export default async function CollectionPage({
  params,
  searchParams,
}: CollectionPageProps) {
  const { address } = await params;
  const { cursor } = await searchParams;
  const queryClient = makeQueryClient();
  const selectedCollection = getMarketplaceRuntimeConfig().collections.find(
    (collection) => collection.address === address,
  );

  await prefetchTraitNamesSummary(queryClient, {
    address,
    projectId: selectedCollection?.projectId,
  });

  return (
    <main className="flex min-h-screen w-full items-start px-4 pb-6 sm:px-6">
      <HydrationBoundary state={dehydrate(queryClient)}>
        <Suspense fallback={<CollectionPageSkeleton />}>
          <CollectionRouteContainer address={address} cursor={cursor ?? null} />
        </Suspense>
      </HydrationBoundary>
    </main>
  );
}

export async function generateMetadata({
  params,
}: CollectionPageProps): Promise<Metadata> {
  const { address } = await params;
  const { getCollectionShareData } = await import("@/lib/marketplace/seo-data");
  const card = await getCollectionShareData(address);
  const copy = collectionShareCopy(card);
  const pathname = `/collections/${address}`;

  return buildMarketplacePageMetadata({
    title: `${copy.title} | Realms.market`,
    description: copy.description,
    pathname,
    image: shareCardImage(pathname, card.version, copy.imageAlt),
    noIndex: !card.exists,
  });
}
