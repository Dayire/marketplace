import { createContractAccess, type ContractReader } from "./contract.js";
import { QueryClient } from "@tanstack/query-core";
import { createCurrencyRegistry } from "./currencies.js";
import type {
  ApiCollection,
  ApiToken,
  ApiBalance,
  ApiOrder,
  ApiPage,
  MarketConfig,
  IndexStatus,
  SearchResults,
} from "./types.js";
import { createTrades } from "./trades.js";
import {
  TransactionCoordinator,
  type AccountAdapter,
  type PendingStorage,
} from "./transactions.js";
export type Query = Record<string, unknown>;
export type Fetch = typeof globalThis.fetch;
export type Requester = <T>(
  path: string,
  query?: Query,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;
export class MarketplaceApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
    this.name = "MarketplaceApiError";
  }
}
export type MarketplaceOptions = {
  apiUrl: string;
  chain: string;
  chainId: string;
  expectedMarketplace?: string;
  queryClient?: QueryClient;
  fetch?: Fetch;
  headers?: HeadersInit;
  credentials?: RequestCredentials;
  assetBaseUrl?: string;
  contractReader?: ContractReader;
  timeoutMs?: number;
  cacheScope?: string;
};
export type Activity = {
  id: string;
  type: string;
  kind?: string;
  buyerDebit?: string;
  currency?: string;
  buyer?: string;
  seller?: string;
  maker?: string;
  from?: string;
  to?: string;
  provenance: { timestamp: number; transactionHash?: string };
  [key: string]: unknown;
};
export type Notification = {
  id: string;
  type: string;
  collection?: string;
  tokenId?: string;
  read: boolean;
  canonical: boolean;
  provenance: { timestamp: number };
};
export type Facet = {
  name: string;
  kind: string;
  values: Array<{ value: string | number | boolean; count: string }>;
};
export type Statistics = {
  days: number;
  byCurrency: Array<{
    currency: string;
    volume: string;
    sales: number;
    history: Array<{ timestamp: number; price: string }>;
  }>;
  floors: Array<{ currency: string; price: string }>;
  floorHistory?: Array<{
    timestamp: number;
    price: string | null;
    currency: string;
  }>;
};
let nextClient = 0;
export function createMarketplaceClient(options: MarketplaceOptions) {
  options = Object.freeze({
    ...options,
    headers: new Headers(options.headers),
  });
  const queryClient =
    options.queryClient ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 0, gcTime: 300000 },
        mutations: { retry: false },
      },
    });
  const prefix = [
    "marketplace",
    options.apiUrl.replace(/\/$/, ""),
    options.chain,
    options.chainId,
    options.expectedMarketplace ?? "read-only",
    options.cacheScope ?? `client-${++nextClient}`,
  ] as const;
  const currencies = createCurrencyRegistry();
  let accountScope = "public";
  const key = (path: string, query: Query = {}) =>
    [...prefix, accountScope, path, query] as const;
  const assetUrl = (value: string) => {
    const legacy = `/api/marketplace/v1/chains/${options.chain}/assets/`;
    return value.startsWith(legacy)
      ? `${(options.assetBaseUrl ?? options.apiUrl).replace(/\/$/, "")}/v1/chains/${encodeURIComponent(options.chain)}/assets/${value.slice(legacy.length)}`
      : value;
  };
  function resolveAssets(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(resolveAssets);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          key === "image" && typeof child === "string"
            ? assetUrl(child)
            : resolveAssets(child),
        ]),
      );
    return value;
  }
  const transport: Requester = async <T>(
    path: string,
    query: Query = {},
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> => {
    if (
      !path.startsWith("/") ||
      path.includes("..") ||
      path.includes("?") ||
      path.includes("#") ||
      path.startsWith("//") ||
      path.startsWith("/operator")
    )
      throw new Error("Invalid public marketplace path.");
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== null)
        params.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    const headers = new Headers(options.headers);
    if (body !== undefined) headers.set("content-type", "application/json");
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15000);
    const response = await (options.fetch ?? globalThis.fetch)(
      `${options.apiUrl.replace(/\/$/, "")}/v1/chains/${encodeURIComponent(options.chain)}${path}${params.size ? "?" + params : ""}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: options.credentials ?? "same-origin",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        cache: "no-store",
      },
    );
    const payload = await response.json();
    if (
      payload.meta?.schemaVersion &&
      !String(payload.meta.schemaVersion).startsWith("1.")
    )
      throw new MarketplaceApiError(
        "Unsupported marketplace API schema.",
        "INCOMPATIBLE_API",
        response.status,
      );
    if (payload.meta?.chain && payload.meta.chain !== options.chain)
      throw new MarketplaceApiError(
        "Indexer network mismatch.",
        "NETWORK_MISMATCH",
        response.status,
      );
    if (!response.ok)
      throw new MarketplaceApiError(
        payload.error?.message ?? "Marketplace request failed",
        payload.error?.code ?? "API_ERROR",
        response.status,
      );
    return resolveAssets(payload.data) as T;
  };
  const queryOptions = <T>(path: string, query: Query = {}) => ({
    queryKey: key(path, query),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      transport<T>(path, query, undefined, signal),
    retry: false as const,
    staleTime: 0,
  });
  const request: Requester = <T>(
    path: string,
    query: Query = {},
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> =>
    body === undefined
      ? signal
        ? transport<T>(path, query, undefined, signal)
        : queryClient.fetchQuery(queryOptions<T>(path, query))
      : queryClient
          .getMutationCache()
          .build<T, Error, unknown, unknown>(queryClient, {
            mutationKey: key(path, query),
            mutationFn: () => transport<T>(path, query, body, signal),
            retry: false,
          })
          .execute(body);
  const config = async () => {
    const c = await request<MarketConfig>("/marketplace/config");
    if (
      c.chain !== options.chain ||
      BigInt(c.chainId) !== BigInt(options.chainId)
    )
      throw new Error("Indexer network does not match this client.");
    if (
      options.expectedMarketplace &&
      (!c.marketplace ||
        BigInt(c.marketplace) !== BigInt(options.expectedMarketplace))
    )
      throw new Error("Marketplace deployment mismatch.");
    currencies.configure(c.currencies);
    return c;
  };
  const read =
    <T>(path: string) =>
    (query: Query = {}) =>
      request<T>(path, query);
  const coordinator = new TransactionCoordinator({
    request,
    invalidate: () => queryClient.invalidateQueries({ queryKey: prefix }),
  });
  const transactions = Object.assign(coordinator, {
    async watch(account: AccountAdapter, storage?: PendingStorage) {
      if (!options.expectedMarketplace)
        throw new Error(
          "Pin the expected marketplace before monitoring transactions.",
        );
      const c = {
        chain: options.chain,
        chainId: options.chainId,
        marketplace: options.expectedMarketplace,
        demo: false,
        status: { safeForCheckout: false },
      };
      return coordinator.resume(() => ({
        account,
        config: c,
        expectedMarketplace: options.expectedMarketplace,
        storage,
      }));
    },
  });
  const contract = createContractAccess({
    chain: options.chain,
    chainId: options.chainId,
    marketplace: options.expectedMarketplace,
    reader: options.contractReader,
    queryClient,
    queryKey: key,
    transactions,
  });
  const cancellationConfig = options.contractReader
    ? async (): Promise<MarketConfig> => {
        const onChain = await contract.getConfig();
        return {
          chain: options.chain,
          chainId: options.chainId,
          marketplace: options.expectedMarketplace!,
          feeBps: onChain.feeBps,
          feeRecipient: onChain.feeRecipient,
          paused: onChain.paused,
          demo: false,
          currencies: [],
          collections: [],
          status: {
            chain: options.chain,
            marketplace: options.expectedMarketplace!,
            indexedBlock: null,
            chainHead: null,
            lagBlocks: null,
            observedAt: null,
            generation: 0,
            safeForCheckout: false,
            reasons: ["DIRECT_CANCELLATION"],
          },
        };
      }
    : undefined;
  return {
    options: Object.freeze({ ...options }),
    queryClient,
    queryKey: key,
    queryOptions,
    request,
    currencies,
    assetUrl,
    transactions,
    contract,
    config,
    status: () => request<IndexStatus>("/indexer/status"),
    collections: {
      list: () => request<ApiCollection[]>("/collections"),
      get: (address: string) =>
        request<ApiCollection>(`/collections/${address}`),
      traitValues: (address: string, name: string, query: Query = {}) =>
        request<Facet[]>(
          `/collections/${address}/traits/${encodeURIComponent(name)}`,
          query,
        ),
      traits: (address: string, query: Query = {}) =>
        request<Facet[]>(`/collections/${address}/traits`, query),
      stats: (address: string, query: Query = {}) =>
        request<Statistics>(`/collections/${address}/stats`, query),
    },
    tokens: {
      bestBid: (collection: string, id: string, query: Query = {}) =>
        request<{
          best: {
            order: ApiOrder;
            sellerProceeds: string;
            checkedBlock: number;
          } | null;
          checked: number;
          complete: boolean;
          label: string;
        }>(`/tokens/${collection}/${BigInt(id)}/best-bid`, query),
      list: (collection: string, query: Query = {}) =>
        request<ApiPage<ApiToken>>(`/collections/${collection}/tokens`, query),
      get: (collection: string, id: string) =>
        request<ApiToken>(`/tokens/${collection}/${BigInt(id)}`),
      activity: (collection: string, id: string, query: Query = {}) =>
        request<ApiPage<Activity>>(
          `/tokens/${collection}/${BigInt(id)}/activity`,
          query,
        ),
    },
    orders: {
      lookup: (orders: Array<{ maker: string; nonce: string }>) =>
        request<{
          orders: Array<{
            key: { maker: string; nonce: string };
            order: ApiOrder | null;
          }>;
        }>("/orders/lookup", {}, { orders }),
      list: (collection: string, query: Query = {}) =>
        request<ApiPage<ApiOrder>>(`/collections/${collection}/orders`, query),
      listings: (collection: string, query: Query = {}) =>
        request<ApiPage<ApiOrder>>(
          `/collections/${collection}/listings`,
          query,
        ),
      offers: (collection: string, query: Query = {}) =>
        request<ApiPage<ApiOrder>>(`/collections/${collection}/offers`, query),
    },
    accounts: {
      holdings: (account: string, query: Query = {}) =>
        request<ApiPage<ApiToken>>(`/accounts/${account}/holdings`, query),
      balances: (account: string, query: Query = {}) =>
        request<ApiPage<ApiBalance>>(`/accounts/${account}/balances`, query),
      orders: (account: string, query: Query = {}) =>
        request<ApiPage<ApiOrder>>(`/accounts/${account}/orders`, query),
      activity: (account: string, query: Query = {}) =>
        request<ApiPage<Activity>>(`/accounts/${account}/activity`, query),
    },
    search: (q: string) =>
      request<SearchResults>("/search", {
        q,
      }),
    notifications: {
      list: read<Notification[]>("/notifications"),
      markRead: (id: string) => request("/notifications/read", {}, { id }),
    },
    report: (body: { collection: string; tokenId?: string; reason: string }) =>
      request("/reports", {}, body),
    auth: {
      async logout() {
        await request("/auth/logout", {}, {});
        accountScope = "public";
        queryClient.removeQueries({ queryKey: prefix });
      },
      session: () => request<{ account: string | null }>("/auth/session"),
      async verify(
        account: string,
        origin: string,
        sign: (data: unknown) => Promise<unknown>,
      ) {
        const challenge = await request<{
          id: string;
          origin: string;
          typedData: unknown;
        }>("/auth/challenge", {}, { account, origin });
        if (challenge.origin !== origin)
          throw new Error("Login origin mismatch.");
        const signature = await sign(challenge.typedData);
        await request("/auth/verify", {}, { id: challenge.id, signature });
        accountScope = account;
        await queryClient.invalidateQueries({ queryKey: prefix });
      },
    },
    setAccountScope(account?: string) {
      accountScope = account ?? "public";
    },
    trades: createTrades({
      cancellationConfig,
      request,
      config,
      chain: options.chain,
      expectedMarketplace: options.expectedMarketplace,
      transactions,
    }),
    dispose() {
      queryClient.removeQueries({ queryKey: prefix });
      if (!options.queryClient) queryClient.clear();
    },
  };
}
export type MarketplaceClient = ReturnType<typeof createMarketplaceClient>;
