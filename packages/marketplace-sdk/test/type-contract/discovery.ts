import { createMarketplaceClient } from "../../dist/index.js";
import type { ApiToken, ApiCollection, ApiBalance } from "../../dist/index.js";

const client = createMarketplaceClient({ apiUrl: "https://api.example", chain: "LOCAL", chainId: "0x1" });
const oldCollection: ApiCollection = { address: "0xa", name: "Legacy", tokenCount: "1", listingCount: "0", floorByCurrency: [] };
void oldCollection;
client.accounts.holdings("0x2").then((page) => {
  const oldConsumer: ApiToken = page.items[0];
  const singleOwner: string = oldConsumer.owner;
  void singleOwner;
});
client.accounts.balances("0x2").then((page) => {
  const balance: ApiBalance = page.items[0];
  const quantity: string = balance.balance;
  const id: string = balance.tokenId;
  const felts: [string, string] = balance.balanceFelts;
  const sourceScope: "page" | undefined = page.sourceScope;
  const sourceReady: boolean | undefined = page.sources?.[0].source?.ready;
  // @ts-expect-error Quantities cannot silently become imprecise JS numbers.
  const unsafeQuantity: number = balance.balance;
  void [quantity, id, felts, sourceScope, sourceReady, unsafeQuantity];
});
client.collections.get("0xa").then((collection) => {
  const confidence: "partial" | "complete" | undefined = collection.reconciliation?.confidence;
  const projectedCount: string | null | undefined = collection.reconciliation?.projectedCount;
  const reasons: string[] | undefined = collection.source?.reasons;
  const generation: number | undefined = collection.generation;
  void [confidence, projectedCount, reasons, generation];
});
client.search("example").then((result) => {
  const standard: "ERC721" | "ERC1155" | undefined = result.discoveredCollections?.[0].standard;
  const basis: "chain" | undefined = result.discoveredCollections?.[0].basis;
  void [standard, basis];
});
