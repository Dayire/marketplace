# @biblio/marketplace

Framework-independent marketplace client and trading workflows for our standalone Cairo contracts and owned indexer. This private workspace package can be packed for another application; it has not been published to a registry.

TanStack Query Core owns fetching, deduplication, query cancellation and cache state. HTTP runs through an injectable Fetch implementation. The SDK imports no React, Next.js, wallet connector or browser storage. The Node indexer remains a separate service using Node built-ins and its approved PostgreSQL driver.

## Create a client

```ts
import { createMarketplaceClient } from '@biblio/marketplace';

const client = createMarketplaceClient({
  apiUrl: '/api/marketplace', // Use an absolute URL on Node.
  chain: 'SN_MAIN',
  chainId: '0x534e5f4d41494e',
  expectedMarketplace: deployment.address, // Required for writes.
});
const collections = await client.collections.list();
const page = await client.tokens.list(collectionAddress, {
  currency: currencyAddress,
  sort: 'price-asc',
  limit: 24,
});
// Continue explicitly with page.nextCursor. The SDK does not load all pages.
```

Cached token asset paths are rebased to the configured API endpoint so another application does not inherit the original Next.js proxy path. Set `assetBaseUrl` when the public asset proxy differs from the API origin (particularly for server-side rendering). External image URLs remain unchanged.

Public groups include collections/traits/statistics, tokens/activity/best bid, orders/listings/offers/lookup, account holdings/orders/activity, search, status/config, notifications/reports, authentication, trades and transactions. `request<T>` and `queryOptions<T>` support additional public endpoints without requiring private imports. HTTP failures retain a code and status; reads and mutations default to no automatic retries. Pass an AbortSignal for cancellation or use QueryClient cancellation. Currency formatting uses each client's registry populated by `config()`; configure custom metadata explicitly before formatting without a config read.

`accounts.holdings(address)` retains the ERC721 `ApiToken.owner` interface.
`accounts.balances(address)` returns positive ERC1155 `ApiBalance` rows with
lossless decimal `tokenId` and `balance` strings and the original uint256 limbs.
Both reads accept an explicit collection, token IDs and bounded keyset pagination.
The latest classified standard suppresses obsolete rows left by class upgrades;
historical activity remains available.

Collection reads expose indexed coverage, source freshness and bounded direct-RPC
reconciliation evidence. Check `source.ready`, `source.reasons` and
`reconciliation.confidence` before treating a projection as current or complete.
Holdings and balance pages include `basis: 'indexed'`, replay `generation`, and
`sources` with `sourceScope: 'page'`: evidence covers returned collections and an
explicit collection filter, rather than the entire account's chain inventory.
Search's `discoveredCollections` uses `basis: 'chain'` to identify discovery
records independently of indexed holdings. Publication, verification and trading
permission remain separate operator policies.

Clients own their query cache by default. An injected `queryClient` is supported; keys include endpoint, chain, chain ID, pinned deployment, client cache scope and account scope. Use a distinct cache scope for independently authenticated consumers. Create a client per server request, supply that request's credentials explicitly, and dispose it afterward. Never reuse a user-authenticated server singleton. `setAccountScope` changes subsequent query identity; it does not authenticate an account.

## Review and submit

```ts
const plan = await client.trades.prepareBuy(wallet.address, selections);
// Present plan.quote and plan.calls to the user before requesting a signature.
const submitted = await client.trades.submit(plan, wallet, pendingStorage);
// Submission is distinct from chain acceptance and index reflection.
await client.transactions.watch(wallet, pendingStorage);
const { state } = client.transactions.getSnapshot();
console.log(submitted.hash, state.stage);
```

`wallet` implements `AccountAdapter`: address, current chain ID, execute, receipt wait and receipt lookup. The host owns wallet connection and provides an adapter for its wallet library. There is no required Starknet.js version. `pendingStorage` implements getItem/setItem/removeItem; a browser host can provide localStorage when executing client-side. Without storage, recovery is in memory for this client only.

Preparation methods cover listings, token offers, collection offers, buying, acceptance, cancellation and repricing. Multi-asset creation/repricing uses account multicall. Checkout is single-currency, at most 25 distinct NFTs and all-or-nothing. Prices and token IDs are lossless decimal strings or bigint at calculation boundaries. Fees and royalties remain contract-enforced; preflight cannot guarantee an eventual fill.

Prepared plans are bound to the creating client and account, are immutable and expire. They cannot be JSON-cloned into a trusted plan. Submission validates the account, wallet chain and expected deployment, and consumes the plan. Prepare again after rejection or changed terms. Signing never happens merely by fetching data or mounting a hook.

`transactions.subscribe/getSnapshot` expose checking, signature, submitted, indexing, accepted, reflected, reverted and error states. `watch` uses the pinned deployment identity and can check receipts even when the configuration endpoint is offline. `watch`/`resume` retain ambiguous receipts and index delays rather than resubmitting. A successful watch can mean accepted with indexing delayed; inspect the state. Unknown wallet submission responses retain intent and block another signature. Only use `reconcileUnknown` after verifying the transaction hash or confirming with the wallet that nothing was submitted. Cancellation remains possible while trading is paused, subject to deployment and network checks.

Concurrency is scoped to a client. Applications sharing a wallet across independent clients/tabs/processes must coordinate them; browser storage alone is not a cross-tab lock. Storage failure before signing fails closed. An in-memory record retains a returned hash if persistence fails after submission; the application must resolve that storage failure before relying on reload recovery.

The exported call builders and preparation functions are advanced interfaces used by the retained app's adapters. Their callers own context binding and review lifetime; use `client.trades` for the complete guarded workflow. Operator credentials and operations stay on the server.

## Sessions and deployment compatibility

Wallet verification requests a domain-bound challenge and calls an explicitly supplied signing function. A same-origin API proxy is the default. Cross-origin cookies require a compatible backend origin/cookie policy or a BFF; setting a URL alone does not establish cross-site authentication. Node callers must supply per-request cookie handling. No private key is accepted or stored by this SDK.

The client targets API v1 and contract ABI v1. Pin `expectedMarketplace` for writes. The backend is responsible for verifying its deployed class and indexed sources. `@biblio/marketplace/abi.json` is generated from the checked-in Cairo ABI during the package build. Extraction does not certify a deployment or replace contract/wallet/production validation.

Run `pnpm sdk:test`, `pnpm sdk:pack:test` and `pnpm contracts:devnet` from the repository root. See the Node and React examples for consumers that only import public exports.

## Contract parity (ABI v1)

Every one of the 17 public marketplace entrypoints has an SDK interface. `CONTRACT_CAPABILITIES` is the machine-readable inventory; tests compare it with the Cairo interface and ABI, verify the source manifest, and pin the supported ABI fingerprint so signature/return-layout changes require an SDK review.

| Cairo entrypoint | Public SDK interface |
| --- | --- |
| `create_listing` | `trades.prepareListing`, `buildCreateOrder` |
| `create_offer` | `trades.prepareTokenOffer`, `buildCreateOrder` |
| `create_collection_offer` | `trades.prepareCollectionOffer`, `buildCreateOrder` |
| `cancel_order` | `trades.prepareCancel` for one order, `buildCancel` |
| `cancel_orders` | `trades.prepareCancel` for multiple orders, `buildCancelOrders` |
| `buy_listing` | `trades.prepareBuyListing`, `buildBuyListing` |
| `buy_many` | `trades.prepareBuy`, `buildBuyMany` |
| `accept_offer` | `trades.prepareAcceptOffer`, `buildAcceptOffer` |
| `accept_collection_offer` | `trades.prepareAcceptOffer`, `buildAcceptCollectionOffer` |
| `get_order` | `contract.getOrder`, `contract.orderQuery` |
| `get_config` | `contract.getConfig`, `contract.configQuery` |
| `quote_terms` | `contract.quoteTerms`, `contract.quoteQuery` |
| `set_collection` | `contract.admin.prepareSetCollection` |
| `set_currency` | `contract.admin.prepareSetCurrency` |
| `set_fee` | `contract.admin.prepareSetFee`, `buildSetFee` |
| `set_paused` | `contract.admin.prepareSetPaused` |
| `propose_admin` | `contract.admin.prepareProposeAdmin` |
| `accept_admin` | `contract.admin.prepareAcceptAdmin` |

Each administration operation also has a corresponding `build…` call builder. `buildConstructorCalldata(admin, feeBps, feeRecipient)` validates deployment inputs; class declaration/deployment itself remains the host provider's responsibility. `contract.admin.prepareSetFee(account, feeBps, recipient)` and `buildSetFee` expose atomic administrator fee updates, capped at 500 bps with a nonzero recipient. Rates apply to new orders; each order retains its `feeBps` snapshot. The current recipient receives fees on future fills, including older orders. `buildCreateOrder` requires `maxFeeBps`; `prepareOrder` requires `context.feeBps`, and the client trading methods bind the reviewed configuration automatically. This ABI revision requires the matching contract/indexer and a fresh deployment-bound database. It has no upgrade, auction, ERC-1155, or pending-admin getter to expose.

### Direct reads and governance

Supply a read-only RPC adapter to use direct contract features. It must return raw serialized felts, not already-decoded contract objects:

```ts
const client = createMarketplaceClient({
  apiUrl,
  chain,
  chainId,
  expectedMarketplace: deployment.address,
  contractReader: {
    getChainId: () => provider.getChainId(),
    call: (call, { blockId }) => provider.callContract(call, blockId),
  },
});
const configuration = await client.contract.getConfig();
const order = await client.contract.getOrder({ maker, nonce });
const quote = await client.contract.quoteTerms(collection, tokenId, buyerDebit);

const pause = await client.contract.admin.prepareSetPaused(wallet.address, true);
// Review the immutable action before explicitly requesting a signature.
await client.contract.admin.submit(pause, wallet, pendingStorage);
await client.transactions.watch(wallet, pendingStorage);
```

Adapt the block identifier to the host provider's format when necessary. Reads support `latest`, `{ block_number }` and `{ block_hash }`, share the TanStack cache and cancellation signal, and validate the reader's chain. SDK reads decode `u256` and `u64` into lossless strings, distinguish missing/open/filled/cancelled orders, and reject unknown versions, malformed booleans, invalid limbs or quote accounting. Expiration remains derived from the stored expiry; it is not a separate on-chain state.

`quoteTerms` is a creation quote using current royalties. Existing token-specific orders retain the royalties returned by `getOrder`; a new royalty quote does not rewrite them. Order creation returns a transaction hash through the account adapter; retrieve the resulting maker nonce from indexed `ApiOrder.nonce` and correlate `createdAt.transactionHash` after reflection, or decode the receipt's OrderCreated event using the shipped ABI.

Governance preparation checks the current administrator using RPC. The contract has no pending-admin view: `prepareAcceptAdmin` cannot attest nomination, and Cairo enforces it during execution. Plans expire, reject foreign accounts/clients, and are rechecked before signing. Governance is independent of the indexer's HTTP availability and remains usable while paused. Contract administration uses wallet authority; it is separate from the backend's private operator/content-moderation credentials. Enabling a collection on-chain does not automatically onboard its history into the indexer registry.

When a reader is configured, cancellation preparation/submission also reads on-chain configuration, so an indexer outage cannot strand cancellations. Once cancellation or governance is confirmed on-chain, index lag is reported as `accepted` without blocking subsequent explicit actions. Repeated cancellation may emit no marketplace event; the SDK reports on-chain acceptance and avoids waiting for an event that cannot arrive. It does not claim that stale indexed data is refreshed. Ordinary trade recovery remains locked until reflection to prevent accidental duplicate submissions.

### Exact bounds and advanced order terms

Use either `royaltyPercent` (the existing convenience/UI policy, at most 50%) or `maxRoyalty` (exact base-unit `u256` cap). Absolute caps expose the full contract range. Collection offers still require strictly positive proceeds at the cap; token orders enforce positive proceeds against their actual royalty snapshot. Use either relative `durationSeconds` or absolute `expiry`; strings/bigints preserve the full `u64` range. Unsafe JavaScript numbers are rejected.

`prepareBuy` keeps the bounded-deadline `buy_many` path, even for a one-item cart. `prepareBuyListing` deliberately exposes native `buy_listing`, whose ABI has no caller-supplied deadline; the local review expires before submission and the contract still enforces order expiry and maximum payment. Choose the cart path when an on-chain caller deadline is required.

Ambiguous wallet responses set `TradeState.unknownSubmission`. Retained intent
blocks another submission until a deliberate `reconcileUnknown` call supplies a
verified transaction hash or `{ confirmedNotSubmitted: true }` after inspecting
wallet activity. This low-level method trusts the caller's evidence; it does not
perform network verification. The reference app verifies hash/network/sender and
requires confirmation of the intended action, then calls `resume`. Do not clear
pending storage on generic transport errors or automatically retry the signature.

`collectionRoyaltyLimit(config.collections, addresses)` returns the highest reviewed royalty percentage for a selection, normalizing address padding and rejecting unknown or explicitly disabled collections and invalid basis points. Treat estimates using this ceiling as minimum seller proceeds; settlement snapshots actual token royalties and checks collection-offer royalties at fill time.
