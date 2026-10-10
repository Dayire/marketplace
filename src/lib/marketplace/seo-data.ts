import { cache } from "react";
import { unstable_cache } from "next/cache";
import type { TokenActivityItem } from "@/features/token/token-activity";
import {
  getCollectionShareBanner,
  getCollectionSquareImage,
} from "@/lib/marketplace/collection-banners";
import { getCollectionFilterConfig } from "@/lib/marketplace/collection-filter-config";
import { getMarketplaceRuntimeConfig } from "@/lib/marketplace/config";
import {
  formatAddress,
  tokenMediaSources,
  tokenName,
} from "@/lib/marketplace/token-display";
import type { ApiOrder, ApiPage, MarketConfig } from "@/lib/marketplace/types";
import {
  decimalTokenId,
  PREFERRED_SHARE_CURRENCY,
  selectCollectionFloor,
  selectListingPrice,
  selectUnlistedPrice,
  shareCardVersion,
  summarizeShareTraits,
  type ShareCurrency,
  type SharePrice,
  type ShareTraitSummary,
} from "@/lib/seo/share-card-model";

const COLLECTION_CACHE_REVALIDATE_SECONDS = 300;
const TOKEN_CACHE_REVALIDATE_SECONDS = 60;

type TokenLike = {
  token_id?: unknown;
  owner?: unknown;
  image?: unknown;
  metadata?: unknown;
};

type TokenDetailsLike = {
  token?: TokenLike | null;
  listings?: Array<{ apiOrder?: ApiOrder }>;
} | null;

type MarketplaceClientLike = {
  getCollection(options: {
    address: string;
    projectId?: string;
    fetchImages?: boolean;
  }): Promise<unknown>;
  getToken(options: {
    collection: string;
    tokenId: string;
    projectId?: string;
    fetchImages?: boolean;
  }): Promise<TokenDetailsLike>;
};

type MarketplaceModule = {
  createMarketplaceClient(config: unknown): Promise<MarketplaceClientLike>;
  marketplaceRequest<T>(path: string, query?: Record<string, unknown>): Promise<T>;
};

export type TokenShareData = {
  exists: boolean;
  tokenName: string;
  /** Decimal token ID. */
  tokenId: string;
  collectionName: string;
  verified: boolean;
  price: SharePrice | null;
  traits: ShareTraitSummary;
  /** Artwork references in preference order: the token's, then the collection's. */
  artwork: string[];
  /** Content hash; changes whenever the rendered card would. */
  version: string;
};

export type CollectionShareData = {
  exists: boolean;
  name: string;
  description: string | null;
  verified: boolean;
  floor: SharePrice | null;
  listedCount: string | null;
  supply: string | null;
  artwork: string[];
  version: string;
};

function asRecord(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function alternateTokenId(rawTokenId: string) {
  const tokenId = rawTokenId.trim();
  if (!tokenId) {
    return null;
  }

  if (/^0x[0-9a-fA-F]+$/.test(tokenId)) {
    try {
      return BigInt(tokenId).toString();
    } catch {
      return null;
    }
  }

  if (/^\d+$/.test(tokenId)) {
    try {
      return `0x${BigInt(tokenId).toString(16)}`;
    } catch {
      return null;
    }
  }

  return null;
}

function hasUsableToken(
  data: TokenDetailsLike,
): data is NonNullable<TokenDetailsLike> & { token: TokenLike } {
  return data !== null && data.token !== null && data.token !== undefined;
}

function resolveCollectionContext(address: string) {
  const config = getMarketplaceRuntimeConfig();
  const knownCollection = config.collections.find(
    (entry) => entry.address.toLowerCase() === address.toLowerCase(),
  );

  return {
    name: knownCollection?.name ?? formatAddress(address),
    projectId: knownCollection?.projectId,
  };
}

function collectionFields(rawCollection: unknown) {
  const fields = asRecord(rawCollection);
  const metadata = asRecord(fields?.metadata);
  const floors = Array.isArray(fields?.floorByCurrency) ? fields.floorByCurrency : [];

  return {
    name: asNonEmptyString(metadata?.name) ?? asNonEmptyString(fields?.name),
    description:
      asNonEmptyString(metadata?.description) ?? asNonEmptyString(fields?.description),
    image: asNonEmptyString(fields?.image) ?? asNonEmptyString(metadata?.image),
    verified: fields?.verified === true,
    listedCount: asNonEmptyString(fields?.listingCount),
    supply: asNonEmptyString(fields?.tokenCount) ?? asNonEmptyString(fields?.totalSupply),
    floors: floors.flatMap((floor) => {
      const entry = asRecord(floor);
      const currency = asNonEmptyString(entry?.currency);
      const price = asNonEmptyString(entry?.price);
      return currency && price
        ? [{ currency, price, symbol: asNonEmptyString(entry?.symbol) ?? undefined }]
        : [];
    }),
  };
}

/** Local share banners first: known-good, small art the renderer can draw. */
function collectionArtwork(name: string, image: string | null) {
  return [getCollectionShareBanner(name), image].filter(
    (value, index, all): value is string => !!value && all.indexOf(value) === index,
  );
}

let marketplaceModulePromise: Promise<MarketplaceModule | null> | undefined;

/**
 * Imported once per process; concurrent callers share the same import. A
 * failed import is not kept, so the next caller retries it.
 */
function loadMarketplaceModule() {
  marketplaceModulePromise ??= import("@/lib/marketplace/api-client").then(
    (loaded) => loaded as unknown as MarketplaceModule,
    () => {
      marketplaceModulePromise = undefined;
      return null;
    },
  );
  return marketplaceModulePromise;
}

const getMarketplaceClient = cache(async (): Promise<MarketplaceClientLike | null> => {
  const marketplaceModule = await loadMarketplaceModule();
  if (!marketplaceModule) {
    return null;
  }

  try {
    const { sdkConfig } = getMarketplaceRuntimeConfig();
    return await marketplaceModule.createMarketplaceClient(sdkConfig);
  } catch {
    return null;
  }
});

/** Reads that only shape the card: a failure leaves the figure out. */
async function optionalRequest<T>(path: string, query?: Record<string, unknown>) {
  const marketplaceModule = await loadMarketplaceModule();
  if (!marketplaceModule) return null;
  try {
    return await marketplaceModule.marketplaceRequest<T>(path, query);
  } catch {
    return null;
  }
}

const fetchCurrencies = unstable_cache(
  async (): Promise<ShareCurrency[]> => {
    const config = await optionalRequest<Pick<MarketConfig, "currencies">>(
      "/marketplace/config",
    );
    return (config?.currencies ?? []).map(({ address, symbol, decimals }) => ({
      address,
      symbol,
      decimals,
    }));
  },
  ["share-currencies"],
  { revalidate: COLLECTION_CACHE_REVALIDATE_SECONDS },
);

async function fetchCollection(address: string, projectId?: string) {
  const client = await getMarketplaceClient();
  if (!client) return null;
  try {
    return await client.getCollection({ address, projectId, fetchImages: true });
  } catch {
    return null;
  }
}

async function fetchTokenWithFallback(options: {
  collection: string;
  tokenId: string;
  projectId?: string;
}) {
  const client = await getMarketplaceClient();
  if (!client) {
    return null;
  }

  let response: TokenDetailsLike = null;

  try {
    response = await client.getToken({
      collection: options.collection,
      tokenId: options.tokenId,
      projectId: options.projectId,
      fetchImages: true,
    });
  } catch {
    response = null;
  }

  if (hasUsableToken(response)) {
    return response;
  }

  const fallbackTokenId = alternateTokenId(options.tokenId);
  if (!fallbackTokenId || fallbackTokenId === options.tokenId) {
    return null;
  }

  try {
    const fallbackResponse = await client.getToken({
      collection: options.collection,
      tokenId: fallbackTokenId,
      projectId: options.projectId,
      fetchImages: true,
    });

    return hasUsableToken(fallbackResponse) ? fallbackResponse : null;
  } catch {
    return null;
  }
}

/** Top offer or last sale, read only when the token has no valid listing. */
async function unlistedPrice(
  address: string,
  tokenId: string,
  currencies: ShareCurrency[],
) {
  const [offers, activity] = await Promise.all([
    optionalRequest<ApiPage<ApiOrder>>(`/collections/${address}/offers`, {
      state: "open",
      tokenMatch: tokenId,
      limit: 50,
    }),
    optionalRequest<ApiPage<TokenActivityItem>>(`/tokens/${address}/${tokenId}/activity`, {
      limit: 20,
    }),
  ]);

  return selectUnlistedPrice({
    offers: (offers?.items ?? []).filter(
      (order) => order.tokenId == null || decimalTokenId(order.tokenId) === tokenId,
    ),
    activity: activity?.items ?? [],
    currencies,
    preferredCurrency: PREFERRED_SHARE_CURRENCY,
  });
}

async function buildTokenShareData(address: string, rawTokenId: string): Promise<TokenShareData> {
  const context = resolveCollectionContext(address);
  const [rawCollection, tokenDetail, currencies] = await Promise.all([
    fetchCollection(address, context.projectId),
    fetchTokenWithFallback({
      collection: address,
      tokenId: rawTokenId,
      projectId: context.projectId,
    }),
    fetchCurrencies(),
  ]);

  const collection = collectionFields(rawCollection);
  const collectionName = collection.name ?? context.name;
  // The token card's artwork plate is square, so square collection art beats a banner.
  const fallbackArtwork = [
    getCollectionSquareImage(collectionName),
    ...collectionArtwork(collectionName, collection.image),
  ].filter((value, index, all): value is string => !!value && all.indexOf(value) === index);
  const token = tokenDetail?.token;

  if (!token) {
    const unavailable = {
      exists: false,
      tokenName: `Token #${rawTokenId}`,
      tokenId: decimalTokenId(rawTokenId),
      collectionName,
      verified: collection.verified,
      price: null,
      traits: { layout: "list", items: [] },
      artwork: fallbackArtwork,
    } satisfies Omit<TokenShareData, "version">;
    return { ...unavailable, version: shareCardVersion(unavailable) };
  }

  const tokenId = decimalTokenId(String(token.token_id ?? rawTokenId));
  const owner = asNonEmptyString(token.owner);
  const listings = (tokenDetail.listings ?? []).flatMap((entry) =>
    entry.apiOrder ? [entry.apiOrder] : [],
  );
  const price =
    selectListingPrice({
      listings,
      owner,
      nowSeconds: Math.floor(Date.now() / 1000),
      currencies,
      preferredCurrency: PREFERRED_SHARE_CURRENCY,
    }) ?? (await unlistedPrice(address, tokenId, currencies));

  const filterConfig = getCollectionFilterConfig(address);
  const name = tokenName(token as never);
  const content = {
    exists: true,
    tokenName: name,
    tokenId,
    collectionName,
    verified: collection.verified,
    price,
    traits: summarizeShareTraits({
      collectionName,
      tokenId,
      metadata: token.metadata,
      hiddenTraits: filterConfig.hiddenTraits,
      orderedTraits: filterConfig.orderedTraits,
    }),
    artwork: [
      ...tokenMediaSources(token as never).slice(0, 4),
      ...fallbackArtwork,
    ].filter((value, index, all) => all.indexOf(value) === index),
  } satisfies Omit<TokenShareData, "version">;

  return {
    ...content,
    version: shareCardVersion({ ...content, artwork: content.artwork[0] ?? null }),
  };
}

async function buildCollectionShareData(address: string): Promise<CollectionShareData> {
  const context = resolveCollectionContext(address);
  const [rawCollection, currencies] = await Promise.all([
    fetchCollection(address, context.projectId),
    fetchCurrencies(),
  ]);
  const collection = collectionFields(rawCollection);
  const name = collection.name ?? context.name;

  const content = {
    exists: rawCollection !== null,
    name,
    description: collection.description,
    verified: collection.verified,
    floor: selectCollectionFloor({
      floors: collection.floors,
      currencies,
      preferredCurrency: PREFERRED_SHARE_CURRENCY,
    }),
    listedCount: collection.listedCount,
    supply: collection.supply,
    artwork: collectionArtwork(name, collection.image),
  } satisfies Omit<CollectionShareData, "version">;

  return { ...content, version: shareCardVersion(content) };
}

const getTokenShareDataCached = unstable_cache(buildTokenShareData, ["share-token"], {
  revalidate: TOKEN_CACHE_REVALIDATE_SECONDS,
});

const getCollectionShareDataCached = unstable_cache(
  buildCollectionShareData,
  ["share-collection"],
  { revalidate: COLLECTION_CACHE_REVALIDATE_SECONDS },
);

/**
 * Everything a token page's metadata and share image need. Cached across
 * requests for a minute, and deduplicated within a request, so the metadata
 * and the image it points at describe the same state.
 */
export const getTokenShareData = cache((address: string, tokenId: string) =>
  getTokenShareDataCached(address, tokenId),
);

export const getCollectionShareData = cache((address: string) =>
  getCollectionShareDataCached(address),
);
