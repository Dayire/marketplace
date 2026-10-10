export type ChainProvenance = {
  timestamp: number;
  blockNumber?: number;
  blockHash?: string;
  transactionHash?: string;
  eventIndex?: number;
};
export type ApiToken = CatalogSourceFields & {
  id: string;
  collection: string;
  tokenId: string;
  owner: string;
  metadata: Record<string, unknown>;
  attributes: Array<{ name: string; value: string | number | boolean }>;
  image?: string | null;
  bestListing?: ApiOrder;
  listings?: ApiOrder[];
  metadataStatus?: string;
};
/** Positive indexed balances; ERC1155 has no single-owner ERC721 projection. */
export type ApiBalance = {
  id: string;
  standard: "ERC1155";
  collection: string;
  tokenId: string;
  owner: string;
  balance: string;
  balanceFelts: [string, string];
  metadata: Record<string, unknown>;
  attributes: Array<{ name: string; value: string | number | boolean }>;
  image?: string | null;
  metadataStatus?: string;
  updatedAt?: ChainProvenance;
};
export type CollectionCoverage = {
  startBlock: number | null;
  block: number | null;
  hash: string | null;
  observedAt: number | null;
  id?: string;
  chainId?: string;
  address?: string;
  sourceType?: "nft" | "marketplace" | "discovery";
  mode?: "catalog" | "configured_scan";
  replayGeneration?: number;
  gaps?: Array<{ from: number; to: number; reason: string }>;
};
export type CollectionChainState = {
  state: "unknown" | "candidate" | "syncing" | "indexed" | "unsupported" | "failed";
  standard: "ERC721" | "ERC1155" | null;
  method: string | null;
  uncertainty: string | null;
  decoderVersion: string | null;
  replayGeneration: number;
};
export type SourceFreshness = {
  ready: boolean;
  reasons: string[];
  generation: number;
  chainHead: number | null;
  observedAt: number | null;
};
export type ReconciliationEvidence = {
  state: string | null;
  ok: boolean;
  confidence: "partial" | "complete";
  checked: number | null;
  projectedCount: string | null;
  mismatches: Array<{ tokenId: string; owner?: string; expected: string; actual: string; method: string }>;
  errors: Array<{ code: string; message: string; tokenId?: string; owner?: string; method?: string }>;
  limitations: string[];
  block: number | null;
  hash: string | null;
  replayGeneration: number;
  observedAt: number | null;
  supply?: string | null;
};
export type CatalogSourceFields = {
  basis?: "indexed" | "chain";
  generation?: number;
  coverage?: CollectionCoverage | null;
  chain?: CollectionChainState | null;
  source?: SourceFreshness | null;
  reconciliation?: ReconciliationEvidence | null;
};
export type DiscoveredCollection = CatalogSourceFields & {
  address: string;
  state: CollectionChainState["state"];
  standard: "ERC721" | "ERC1155";
  method: string | null;
  basis: "chain";
};
export type SearchResults = {
  collections: ApiCollection[];
  tokens: ApiToken[];
  discoveredCollections?: DiscoveredCollection[];
};
export type ApiOrder = {
  id: string;
  maker: string;
  nonce: string;
  kind: "listing" | "token_offer" | "collection_offer";
  state: "open" | "filled" | "cancelled";
  availability?: string;
  collection: string;
  tokenId: string | null;
  currency: string;
  buyerDebit: string;
  expiry: string;
  royaltyAmount: string;
  royaltyCap: string;
  royaltyRecipient: string;
  feeBps: number;
  createdAt?: ChainProvenance;
  updatedAt?: ChainProvenance;
};
export type ApiCollection = CatalogSourceFields & {
  address: string;
  name: string;
  description?: string;
  image?: string | null;
  verified?: boolean;
  tokenCount: string;
  listingCount: string;
  floorByCurrency: Array<{ currency: string; symbol: string; price: string }>;
};
export type ApiPage<T> = {
  items: T[];
  nextCursor: string | null;
  basis?: "indexed";
  generation?: number;
  standard?: "ERC1155";
  /** Evidence covers this page's collections and any explicit collection filter. */
  sourceScope?: "page";
  sources?: Array<CatalogSourceFields & { collection: string }>;
};
export type IndexStatus = {
  chain: string;
  marketplace: string | null;
  indexedBlock: number | null;
  chainHead: number | null;
  lagBlocks: number | null;
  observedAt: number | null;
  generation: number;
  safeForCheckout: boolean;
  reasons: string[];
  history?: {
    mode: "event_ranges";
    state:
      | "pending"
      | "reconciling"
      | "failed"
      | "passed"
      | "invalid_checkpoint";
    cutoff: number;
    lastRangeEnd?: number;
    checkpointBlock?: number;
    checkpointHash?: string;
    checkedTokens?: number;
    checkedOperators?: number;
    supply?: string;
    completedAt?: number;
    error?: string | null;
  };
};
export type MarketConfig = {
  chain: string;
  chainId: string;
  marketplace: string | null;
  feeBps: number;
  feeRecipient: string;
  paused: boolean;
  demo: boolean;
  currencies: Array<{ address: string; symbol: string; decimals: number }>;
  collections: Array<{
    address: string;
    name: string;
    royaltyBps?: number;
    enabled?: boolean;
  }>;
  status: IndexStatus;
};
