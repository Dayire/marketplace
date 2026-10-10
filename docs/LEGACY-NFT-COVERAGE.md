# Legacy NFT adapters and pinned replay evidence

This evidence covers the legacy work in [issue #116](https://github.com/BibliothecaDAO/marketplace/issues/116) and the reconciliation strategy in [issue #112](https://github.com/BibliothecaDAO/marketplace/issues/112). [BUILD-PLAN.md](./BUILD-PLAN.md) owns launch gates; [BACKEND-SCOPE.md](./BACKEND-SCOPE.md) owns indexing and recovery requirements.

## Supported evidence and version boundaries

The [frozen public fixture](../services/marketplace-backend/test/fixtures/legacy-mainnet.json) contains eight complete ABIs, three selected transaction receipts, exact block positions and pinned RPC observations. Each ABI and receipt has a SHA-256 digest. ABIs were obtained with `starknet_getClass` at the recorded hash; receipts are public mainnet records, rather than generated events. The Briq address is also listed in the project's [official protocol README](https://github.com/briqNFT/briq-protocol#current-mainnet-addresses).

| Contract | Verified implementation and layout | Historical provenance | Coverage limit |
| --- | --- | --- | --- |
| Briq sets, `0x01435498bf393da86b4733b9264a86b58a42b31f8d8b8ba309593e5c17847672` | Cairo 0 `Transfer(from_:felt,to_:felt,token_id_:Uint256)` in data; declared `ownerOf` and `tokenURI` aliases; bounded felt-array `URI` notification | Deployment 10423, transaction 28/event 1 declares the initial implementation; first mint 10708, transaction 0/event 0, agrees with the implementation storage read at that hash | No declared NFT `totalSupply` or global `tokenByIndex`; owner-local `tokenOfOwnerByIndex` does not enumerate all collection owners |
| Loot Chests, `0x0572fe34a769058c62a66f0c4854d08ccfd21fcbb4f0b1685a1868b84c6ee266` | Cairo 1 interfaces; keyed transfer/approval fields; u256 IDs; declared NFT supply/global enumeration | Class before 5653721 differs from class at 5653721; the replacement is confirmed by both state diff and ordered `Upgraded` at transaction 0/event 0 | Fixtures prove this replacement boundary; they do not reconstruct the collection's entire history |
| Realms, `0x07ae27a31bb6526e3de9cf02f081f6ce0615ac12a6d7b85ee58b8ad7947a2809` | Cairo 1 interface functions, keyed transfer, `Approval.approved` address distinct from operator-approval boolean | Frozen mints 1038/1830/1101 and pinned immutable class ABI agree with independent live owner reads | No NFT `total_supply` or global `token_by_index`; `get_past_total_supply` is voting evidence and is excluded |
| ETH negative control, `0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7` | Historical proxy and resolved Cairo 0 ERC20 implementation declare `Transfer(value)`, decimals and fungible operations | The fungible transfer is in the same 10708 transaction as the Briq mint; the pinned `implementation()` address and its class are recorded | Classified as fungible/unsupported for NFT indexing, with a visible operator reason |

The exact known Briq proxy class is `0x71429d7850e4421236ed7e4f58b7778fc0e0c01b8770335ba4140bcb13733e9`. Only this bytecode identity uses the verified `Proxy_implementation_hash` storage adapter. Its implementation at 10708 is `0x737075858b01863de9f079aaf45e2a8677eed1b9e7601464957bac0a73dc289`; the separately observed 16050532 implementation is `0x4c407e3eb462e54ed069f5213a6fe95852d3706079a006b71f4d8c5d4b3119b`. These two observations demonstrate a change, but do not establish the intermediate upgrade transactions.

Loot's before/after classes are `0x3786852cc518b276af050047b663b7d750f697dbb9e7c0046c06521d533c047` and `0x181c70595dd7db697c37ceb35c74fab69a037836b99cc80c17fd92a16289e26`. The 5653721 state update and receipt preserve the exact transaction/event boundary. A class or implementation replacement with an unresolved in-block position requires an explicit gap/quarantine; a block-end ABI observation cannot supply an invented event position.

`resolveClassEvidence` returns the source summary separately from its effective implementation summary and preserves the pinned block, method/storage adapter and both class identities. `cacheWrite:false` supports read-only metadata/reconciliation users. ABI-summary version 3 retains exact function input/output signatures, so camelCase/snake_case recognition does not imply an unverified calldata layout.

ABI-known administrative events such as `Upgraded`, `AdminChanged` and `RoleGranted` are retained as unmodeled raw events without NFT state changes. Undeclared selectors and unsupported NFT layouts remain quarantined. A fungible `Transfer(value)` cannot obtain the NFT fallback, even if an inconsistent interface probe claims NFT support. Selector calculation uses owned Keccak code following the [official Keccak reference](https://keccak.team/files/Keccak-reference-3.0.pdf), with known empty/abc digest vectors and every frozen repository selector tested.

## Independent reconciliation

`reconcileCollection(store,rpc,config,{collection,blockHash,blockNumber,limit})` in [legacy-coverage.mjs](../services/marketplace-backend/src/legacy-coverage.mjs) requires an exact canonical hash and matching collection progress. It checks chain identity and the returned block, resolves the class at that hash, and calls only getters whose signatures are proven by that ABI. All wire calldata is hexadecimal; addresses and balances remain lossless.

The bounded scan checks active ERC721 token owners or ERC1155 owner/token balances, including zero balances retained for rollback. It never invents sequential IDs, a holder list or a supply interpretation. Optional ERC721 NFT supply/global enumeration is used only when the declared signatures support it. An owner or balance mismatch, unsupported getter, malformed response or RPC error makes `ok:false` and blocks promotion.

`confidence:"complete"` requires every projected ERC721 token to be checked, a matching declared NFT supply, and a matching unique global enumerable-ID set within the limit. Matching samples without these facts report `confidence:"partial"` with explicit limitations. An empty projection without proven zero supply/enumeration is unavailable, rather than a successful empty collection check. ERC1155 checks retain partial confidence because this adapter has no complete holder-enumeration proof.

The result is persisted as status `reconciliation:<canonical address>` with block/hash, replay generation, decimal-string projected count, bounded mismatches/errors, limitations and provenance. The writer rechecks the source, sampled rows, canonical hash and generation after RPC work. A concurrent rewind prevents persistence; normal canonical undo removes earlier reconciliation status. PostgreSQL migration 011 supplies a full collection/token/owner index for zero-inclusive checks; applied upstream migration checksums are preserved.

## Measured public replay

[legacy-replay-2026-10-10.json](./evidence/legacy-replay-2026-10-10.json) records four independent ephemeral SQLite projections: the Briq first mint and the three previously frozen Realms mints. Each replay agrees with a live direct owner call at its exact historical block hash. Receipt, class, implementation and frozen-ABI identities also agree. The real ETH transfer is separately resolved, rejected by the NFT decoder and visible in operator coverage as `fungible`.

The capture used Node 22.23.3 and the public RPC endpoint, without authentication or fees. It completed 36 logical read-only calls in 2.880 seconds. This is a small historical sample, not a capacity estimate or an exhaustive collection replay. All four owner comparisons correctly report partial confidence; the latest Briq owner observed at 16050532 differs from its mint owner, demonstrating why a mint-only projection cannot establish later ownership.

Reproduce the read-only public comparison from the repository root:

```sh
node services/marketplace-backend/scripts/legacy-proof.mjs https://starknet-rpc.publicnode.com > .context/legacy-proof.json
```

The report keeps request parameters, response digests/byte counts, exact getter results and selected block-header fields. Header projections omit the unrelated transaction list; the recorded digest covers the original full RPC result. The command writes no production data. A provider failure or changed observation exits unsuccessfully and records the failed case.

## Exceptions and regression evidence

| Visible reason | Meaning and operator action |
| --- | --- |
| `fungible` | Explicit ERC20 semantics; preserve the candidate in unsupported coverage and exclude it from NFT indexing |
| `proxy_unverified` / unsupported proxy layout | Supply a reviewed class-specific getter/storage adapter and pinned implementation evidence; do not apply the Briq slot to arbitrary `__default__` contracts |
| `CLASS_BOUNDARY_UNRESOLVED` | Preserve raw events and the gap; obtain a unique ordered upgrade receipt before selecting a same-block version |
| `UNKNOWN_COLLECTION_EVENT` / `INVALID_EVENT` | Preserve raw bytes and bounded first/last quarantine records; add a verified event/member layout before replaying |
| `UNSUPPORTED_GETTER` / `NO_PROJECTED_SAMPLE` | Direct owner/balance evidence is unavailable; obtain a supported declared getter or a usable projection sample before promotion |
| `total_supply_unavailable`, `enumeration_unavailable`, `holder_enumeration_unavailable`, `sample_limit` | Matching bounded observations remain partial and carry these limitations to the API |

Native tests verify actual ABI/receipt digests, Cairo 0 proxy/class evidence, layout aliases, administrative-event retention, a real fungible negative control, unchanged frozen Realms IDs, getter errors/mismatches, enumeration limits and reorg rejection. Real PostgreSQL 18.6 tests verify high u256 values, retained zero balances, the indexed scan, status undo and a concurrent rewind. ERC1155 balance tests in this module use synthetic standard ABI/chain responses and real PostgreSQL; the public mainnet report does not claim an ERC1155 history comparison. Existing policy, production rollout and full-history validation remain governed by the canonical plans.
