# Reviewed mainnet sample and local recovery measurements

Reviewed 2026-10-10T05:55:24.454565+00:00. Final measured code: `6a5caf2db4b8a72d411ad7c7e8b61345fc65e43a`. Current upstream main snapshot: `9b65018cbd804c3ae722587ccca3826b8c820a48`. The earlier `561d94538c794f48ea12ae41617aa6dc8af53432` is retained as a dated baseline, not described as current production. Attribution to PR122 commit `a03ff136c351ed931ad96a9fd7dd17e6c93696e5` is preserved.

The final candidate preserves every original field and row count in the sampled Realms/order/preflight projections. Recent and live common projections are exactly equal to current main after observation-clock normalization. Historical activity adds only `decoder`, `decoderVersion` and receipt-proven `transactionIndex=201`. All replay, recovery, metadata and focused API checks below passed. This packet is bounded measurement evidence; it does not certify complete history, a production release, sustained service capacity or buyer-approved acceptance targets.

## Evidence and sampling

Real network acquisition used `https://starknet-rpc.publicnode.com`, observed chain `SN_MAIN` and RPC specification `0.10.3`. Only read methods were allowed. No transaction was signed/submitted and no deployment occurred. The public registry and frozen code supply the Realms address `0x7ae27a31bb6526e3de9cf02f081f6ce0615ac12a6d7b85ee58b8ad7947a2809` (deployment664162) and marketplace address `0x7ced79b9da11b280209425dce4329d6b8aa5fa03f81a807b9bf3cfbd64cb9d7` (start16050533). [Provider endpoint](https://starknet.publicnode.com/) and [official RPC schema](https://github.com/starkware-libs/starknet-specs/blob/master/api/starknet_api_openrpc.json) are primary references; actual receipts establish availability at the sampled heights.

| Public data | Accepted blocks | Transactions | Registered events | Semantics |
| --- | ---: | ---: | ---: | --- |
| Deployment-era664162–664225 | 64 | 21,239 | 8 | Administrative/deployment events; no NFT transfer |
| Eventful664768–664831 | 64 | 20,413 | 3 | One genuine Realms mint1038 and two adjacent non-transfer events |
| Recent16159924–16159955 | 32 | 49 | 0 | Empty registered-event sample, not proof of no network activity |
| Live16160261–16160276 | 16 | See raw live receipts | 0 | Four bounded accepted-head observations, three-second polling |

Eventful/recent acquisition made118 real requests, sent14,064 request-body bytes and received104,394,770 decoded response bytes; per-request median104.44ms and p95=189.64ms. Historical acquisition took5.17s; recent1.54s. The live probe made51 requests and received148,179 decoded bytes, median60.90ms/p95=135.67ms, over approximately11.6s. Zero public429s were observed. This verifies only that this bounded request budget was accepted, not any continuing quota. Captured head timestamp ages of5.3–8.3s are not independently measured index lag.

Receipt-derived registered events matched duplicate-preserving filtered `getEvents` results. Every recorded block had an accepted status and ordered parent chain; first/last target hashes matched before/after. A single provider supplies both sides, so correlated omissions remain possible. The eventful range has135,782 successful all-emitter receipt events from2,380 addresses. A paginated500-event scan requires62–72 pages per16-block historical chunk. The default64-block shared-acquisition probe deliberately rejected `WINDOW_EVENTS_DENSE` before writing any head; bounded16-block offline replays succeeded.

The observed Realms class was `0x42731c2355af9d59eda314ea3cca49ea3cc85173b2ca3c35c6c9df1c087cc43` at all96 historical/recent sampled blocks and16 live blocks. No upgrade was observed in these samples. Mint1038, transaction `0x519a0257d1b09b255324dac34aab3f5e01a9a88a73cef02a0c9084881892eb8`, occurs at block664768/transaction position201. Its projected owner matches a direct read pinned to recent head16159955: `0x74c2664cfc8aff6b1e24befa444488f89a060f9a58550cd5ef1f9c4809a80c3`. That single match does not reconcile every token or the intervening history.

## Replayed projections and local costs

Actual receipts, headers and per-block class observations were frozen and replayed through production entrypoints into separate isolated PostgreSQL18.6 databases under Node22.23.3. RPC replay has no network latency. Only observation/fetch wall clocks are normalized; raw events, block/transaction hashes, monetary values and chain provenance objects remain. Each source's checkpoint/hash reaches its sample end. Source starts are explicitly moved to the sample first block: strict original-registry preflight remains blocked by `SOURCE_BACKFILL_REQUIRED`. No sample is labeled a full deployment-to-head backfill.

| Frozen version | Historical64 pure scan ms | Recent32 pure scan ms | Live16 pure scan ms |
| --- | ---: | ---: | ---: |
| Dated main561d945 | 231.60 | 16.65 | 7.20 |
| Attributed PR122a03ff13 | 2307.98 | 47.42 | 33.46 |
| Current main snapshot9b65018 | 240.69 | 12.01 | 6.65 |
| Intermediatea1805a4 | 1838.24 | 43.43 | 18.51 |
| Final6a5caf2 | 2819.03 | 41.79 | 84.58 |

These single runs share a workstation with other task-local validation. They describe the observed workload, not statistically established speedups or regressions. Discovery adds genuine all-emitter work and catalog writes; comparing that cost with the original registered-only scanner is not a same-scope throughput claim.

Final candidate SQL measurements exclude the deliberate writer crash from pure scan totals. WAL is actual local LSN difference, database growth is `pg_database_size` difference, and write statements count successful INSERT/UPDATE/DELETE statements rather than logical events.

| Sample | SQL write statements | WAL bytes | Database growth bytes | Offline RPC calls |
| --- | ---: | ---: | ---: | ---: |
| historical | 2620 | 2627920 | 2310144 | 361 |
| recent | 82 | 135016 | 229376 | 45 |
| live | 41 | 74448 | 180224 | 22 |

Current main's backend differs from dated main only in migration4/image-source digest lookup and its regression. Current-vs-dated existing projections were exactly equal in all samples. Current migration4 is retained unchanged in the final chain; additions5–11 do not collide with already applied upstream migrations. Focused final migration/API/metadata checks ran on actual PostgreSQL.

## Actual network backfill bound and freshness proposal

One genuine public-network acquisition plus local PostgreSQL commit of664768–664771 ran on intermediate `a1805a4639493777706ab9f68f612bc8c3838a64`: four accepted blocks,31HTTP requests,11,717,647 decoded response bytes,16 global event pages,306 discovered candidates and one genuine Realms NFT projection. Cycle2,358.75ms comprised2,124ms acquisition and234ms commit; outer before/after boundary reads are excluded. Hash `0x21b7d0e9d94a3c914bb7ce13e7d7027288655707ce90e09b98584a48101cfb6` remained stable; zero429s. This real-network cycle is explicitly intermediate evidence, not a final-code network measurement.

Use four blocks as the initial historical backfill slice, with one round per ordered live-first cycle. Final source-cycle code already uses that default, plus live16, classification8/concurrency2 and queue8. Configure bounded request/time/event budgets and yield between complete slices; a slow RPC operation can still consume its bounded timeout, so a four-block bound is not a hard wall-clock guarantee. From this one2.36s observation, a5s cycle-warning threshold is a reasonable proposed diagnostic starting point, not a pass/fail SLO. Do not relax the existing source-lag/freshness guard to make a sample green. Measure sustained live-first cycles with provider429/outages and a growing source set before agreeing freshness or capacity targets. Buyer agreement is unverified.

An independent older-journal overlay experiment, also intermediate, applied recorded664768–664831 below an existing16159924–16159955 journal in3.16s offline. A forged target was rejected with `BACKFILL_ANCHOR`, an absent first-parent proof with `CHAIN_GAP`, before projection changes. The recent canonical head, marketplace progress and durable fixture survived; genuine1038 was projected. `source_coverage` stayed empty and Realms progress retained the recent source start. The approximately15-million-block gap was not certified.

## Recovery and controlled faults

The final historical experiment killed a real child writer with SIGKILL inside an uncommitted outer transaction at actual recorded boundary664800. All table-content digests remained unchanged. The isolated PostgreSQL process was stopped/restarted, its PID changed, and all table digests matched. Duplicate catch-up took49.30ms and left projections unchanged. The shared test server was not stopped.

An actual PostgreSQL custom-format logical dump of187,595 bytes was restored into a different isolated database: all37 table-content digests matched. Dump233.36ms and restore452.38ms reflect only this small local sample, not production restore time. Dump SHA256: `76f528b30081b8131adb16b0d40189bdc263b103aed81f6ea31fd8f2d3f1ce72`. Application rows and media-byte preservation use explicitly synthetic durable fixtures, not real customer data.

A controlled rollback to actual captured parent664767 removed the mint projection; replay through664831 restored ownership/activity digest and durable fixtures in2430.06ms. No mainnet fork occurred in the observed range. Injected scanner outages kept canonical projections/source checkpoints unchanged, recorded `RPC_UNAVAILABLE` with identity unverified, and recovered on retry. Controlled transport tests separately exercise outage exhaustion,429 then success respecting1000ms Retry-After, and429 exhaustion. Those429s are injected; the provider did not produce a measured429.

## Metadata and HTTP checks

One real pinned inline token URI resolved to419bytes, name `Molslommol`, seven attributes and two Resource values. Metadata SHA256 `c8aca3ebe6292858051e46cf73ddc46d052ced28fe0ba0a2a55e0700f521b29a`. The actual Pinata SVG origin fetch returned645,351bytes in7,891.29ms, SHA256 `f1414a74828aee4b1e3f654b9654cc6bbab1e1c974363c12c0175fea7ee88187`. This is1/1 sampled success, not collection-wide coverage. Subsequent main/final worker experiments replay these exact bytes without further origin traffic. Final successful metadata/image cache, controlled RPC failure with failed job/backoff, and controlled image failure with ready metadata/failed image all preserved ownership. The initial capture script incorrectly called a public-fetch function with a data URI; its preserved error is a corrected harness mistake, not an origin/product failure.

Actual local HTTP/API with PostgreSQL ran a five-second burst at50browse requests/s plus one positive25-row preflight/s. Browse uses the one genuine captured Realms token. Trading uses25 explicitly synthetic LOCAL NFT/order rows and injected direct-read responses; no production trade is claimed. Both current main and final returned255/255HTTP200 and all positive25-row fixture quotes passed. Final browse p95=12.86ms and fixture-preflight p95=51.28ms; current-main p95=9.84/28.09ms. Each burst performs405 injected read-RPC calls. Five quotes/one-token browse cardinality and no real quote-RPC latency cannot establish production p95 capacity. Existing rate limits remain enabled. The final log contains a pg8 deprecation warning for overlapping client queries; no requests failed, and this is preserved for review rather than suppressed.

## Validation receipts and reproducibility

- Measurement invariant tests:4/4.
- Current-main image-cache PostgreSQL regressions:7/7.
- Final migration/catalog/API/image-cache focused PostgreSQL tests:14/14.
- Final additional discovery/metadata scheduling/runtime11/legacy reconciliation group:22/22, comprising12 real PostgreSQL tests and10 native/SQLite ABI-reconciliation fixtures.
- Final public catalog/metadata behavior fixtures:11/11.
- Intermediate decoder/class-change/ERC1155/preflight fixture suite:51/51 native and24/24 PostgreSQL. Upgrade/reorg/malformed-event/uint256 cases are labeled fixtures, not observed mainnet events.

The [machine-readable summary](2026-10-10-nft-mainnet-shadow-summary.json) indexes these measurements, and the [projection comparison](2026-10-10-nft-mainnet-projection-comparison.json) records every additive difference. The complete task-local packet contains the public inputs, request bodies, source archives, controlled-fixture results and withdrawn attempts. Its 1,268-file SHA256 manifest digest is `ab03a086ba6895aa2cf97c66aedee5c0dd5c7542ac942430eb1116f41df272fb`. The raw 557 MB packet is retained outside Git; the bounty handoff supplies a compressed selection sufficient to replay the final three samples. Passwords, database clusters, environment files, unrelated account files and dependency symlinks are excluded.

The [portable runner instructions](../../services/marketplace-backend/bench/PORTABLE-RUNNER.md) describe explicit recorded-input, scratch, output and PostgreSQL18.6 binary paths. The runner invokes the exact frozen production modules; it does not implement its own NFT projector. Its final source archive was checked byte-for-byte against all 672 tracked files of commit `6a5caf2db4b8a72d411ad7c7e8b61345fc65e43a`. The archive is supplied with the handoff because subsequent documentation/bench commits have different Git identities. The portable exact-SHA run passed all three samples and actual process-kill, PostgreSQL restart and logical dump/restore checks.

```sh
node --test services/marketplace-backend/bench/capture-utils.test.mjs \
  services/marketplace-backend/bench/replay-utils.test.mjs
```

Source archive provenance and task-local dependency receipts are recorded; pg CDN per-file hashes do not claim verification of the original npm tarball's full lockfile SHA512. A first final run had a mistyped CLI SHA: it is retained with `WITHDRAWN-PROVENANCE-ERROR.json`, excluded from cited results, and replaced by a clean exact-SHA run. Initial budget-exhausted/harness-failure receipts remain available and are not recast as successful measurements. New acquisition at other windows can produce different results; no replay adapter fills uncaptured history.

Remaining production gates include complete source coverage, sustained shadow/fairness measurement, larger API/metadata workloads with real provider latency, independent event/state checks where available, off-host backup/restore and release-owner acceptance. This packet does not remove those gates.
