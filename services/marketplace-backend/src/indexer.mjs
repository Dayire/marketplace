import {
  chooseHistoryCutoff,
  historyProfile,
  historyProfiles,
  reconcileHistory,
} from "./history.mjs";
import { mapConcurrent } from "./concurrency.mjs";
import { address, ApiError } from "./domain.mjs";
import { decodeEvent, DECODER_CAPABILITY } from "./decode.mjs";
import { collectionKey, collectionRecord } from "./collection-catalog.mjs";
import { emitterCandidateFields } from "./discovery.mjs";
import { summarizeAbi } from "./classify.mjs";
const equal = (a, b) => BigInt(a) === BigInt(b);
const signature = (e) =>
  JSON.stringify([
    address(e.from_address),
    e.keys.map((x) => BigInt(x).toString()),
    e.data.map((x) => BigInt(x).toString()),
  ]);
export async function scanOnce(store, rpc, config, options = {}) {
  try {
    return await scanRange(store, rpc, config, options);
  } catch (error) {
    await store.put("status", "rpc", {
      ...(await store.get("status", "rpc")),
      error: error.code ?? "INDEXER_ERROR",
      identityVerified: false,
    });
    throw error;
  }
}
async function scanRange(
  store,
  rpc,
  config,
  {
    window = 100,
    stopAt,
    receiptConcurrency = 8,
    receiptBatchSize = 1,
    commitBatchSize = 250,
    fastHistory = false,
    historyWindow = 100000,
    scope = null,
    from: fromOption = null,
    maxWindowEvents = 50000,
    emitterBudget = 500,
  } = {},
) {
  // Scoped mode = collection backfill overlay (#113): only the scoped
  // sources are read, written and checkpointed; marketplace acquisition and
  // every other source's progress stay untouched.
  const backfillMode = Array.isArray(scope);
  if (backfillMode) {
    if (!scope.length)
      throw new ApiError("INVALID_SCOPE", "Backfill scope cannot be empty.");
    if (fromOption !== null && (!Number.isSafeInteger(fromOption) || fromOption < 0))
      throw new ApiError("INVALID_SCOPE", "Invalid backfill start block.");
    for (const value of scope)
      if (!config.collections.some((c) => address(c.address) === address(value)))
        throw new ApiError(
          "INVALID_SCOPE",
          `Backfill scope ${value} is not a registered collection.`,
        );
  } else if (fromOption !== null)
    throw new ApiError("INVALID_SCOPE", "Explicit from requires a scope.");
  const started = performance.now(),
    rateLimitsBefore = rpc.rateLimits ?? 0;
  for (const [value, max] of [
    [receiptConcurrency, 32],
    [receiptBatchSize, 32],
    [commitBatchSize, 1000],
    [historyWindow, 100000],
  ])
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new ApiError(
        "INVALID_WINDOW",
        "Invalid bounded indexer concurrency or batch size",
      );
  if (!Number.isSafeInteger(window) || window < 1 || window > 1000)
    throw new ApiError("INVALID_WINDOW", "Scan window must be 1–1000 blocks.");
  for (const [value, label, min, max] of [
    [maxWindowEvents, "window event budget", 100, 1000000],
    [emitterBudget, "emitter budget", 10, 100000],
  ])
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new ApiError("INVALID_WINDOW", `Invalid bounded ${label}`);
  const identity = {
    chainId: "0x" + BigInt(config.chainId).toString(16),
    marketplace: config.marketplace ? address(config.marketplace) : null,
  };
  await store.bindIdentity(identity);
  if (!equal(await rpc.call("starknet_chainId", []), config.chainId))
    throw new ApiError("CHAIN_MISMATCH", "RPC is on another chain.");
  const latest = await rpc.call("starknet_getBlockWithTxHashes", {
    block_id: "latest",
  });
  if (!["ACCEPTED_ON_L1", "ACCEPTED_ON_L2"].includes(latest.status))
    throw new ApiError("UNACCEPTED_HEAD", "RPC head is not accepted.");
  const observedAt = Date.now();
  if (config.marketplaceClassHash && config.marketplace) {
    const hash = await rpc.call("starknet_getClassHashAt", {
      block_id: { block_hash: latest.block_hash },
      contract_address: config.marketplace,
    });
    if (!equal(hash, config.marketplaceClassHash))
      throw new ApiError(
        "CLASS_MISMATCH",
        "Marketplace code identity changed.",
      );
  }
  let head = await store.head();
  while (head) {
    const canonical = await rpc.call("starknet_getBlockWithTxHashes", {
      block_id: { block_number: head.number },
    });
    if (equal(canonical.block_hash, head.hash)) break;
    await store.rewind(head.number - 1);
    head = await store.head();
  }
  const allSources = [
    ...config.collections.map((c) => ({
      address: address(c.address),
      start: c.startBlock,
    })),
    ...(config.marketplace && !backfillMode
      ? [
          {
            address: address(config.marketplace),
            start: config.marketplaceStartBlock,
          },
        ]
      : []),
  ];
  const sources = backfillMode
    ? allSources.filter((source) =>
        scope.some((value) => address(value) === source.address),
      )
    : allSources;
  if (
    !sources.length ||
    sources.some((s) => !Number.isSafeInteger(s.start) || s.start < 0)
  )
    throw new ApiError(
      "INVALID_REGISTRY",
      "Verified source start blocks are required.",
    );
  // A backfill overlay is the sanctioned repair for this exact condition,
  // so scoped runs skip the completeness gate they exist to close (#113).
  if (!backfillMode)
    for (const source of sources) {
      const progress = await store.get("progress", source.address);
      if (
        head &&
        source.start <= head.number &&
        (!progress ||
          !Number.isSafeInteger(progress.startBlock) ||
          progress.startBlock > source.start ||
          progress.block !== head.number ||
          !equal(progress.hash, head.hash))
      )
        throw new ApiError(
          "SOURCE_BACKFILL_REQUIRED",
          `Source ${source.address} has incomplete historical coverage. Rebuild the chain database with the complete registry before publishing it.`,
          409,
        );
    }
  const from =
    fromOption ??
    (head ? head.number + 1 : Math.min(...sources.map((s) => s.start)));
  const history =
    store.dialect === "postgres" ? await store.get("status", "history") : null;
  let cutoff = history?.cutoff;
  if (fastHistory && store.applyEventRange && !cutoff && head)
    cutoff = await chooseHistoryCutoff(rpc, config, latest, from);
  let useFast = !!(
    fastHistory &&
    store.applyEventRange &&
    cutoff &&
    from <= cutoff
  );
  if (useFast) historyProfile(config);
  let end = Math.min(
    latest.block_number,
    from + (useFast ? historyWindow : window) - 1,
    stopAt ?? Infinity,
    ...(history && history.state !== "passed" ? [history.cutoff] : []),
    ...(useFast ? [cutoff] : []),
  );
  await store.put("status", "rpc", {
    head: latest.block_number,
    hash: latest.block_hash,
    observedAt,
    identityVerified: !!config.marketplaceClassHash,
    error: null,
  });
  if (history && history.state !== "passed" && head?.number >= history.cutoff)
    return reconcileHistory(store, rpc, config, history);
  if (from > end) {
    await store.reconcileNotifications();
    return {
      indexed: (await store.head())?.number ?? null,
      head: latest.block_number,
    };
  }
  let anchor = await rpc.call("starknet_getBlockWithTxHashes", {
    block_id: { block_number: end },
  });
  if (useFast && anchor.status !== "ACCEPTED_ON_L1") {
    useFast = false;
    end = Math.min(
      latest.block_number,
      from + window - 1,
      cutoff,
      stopAt ?? Infinity,
    );
    anchor = await rpc.call("starknet_getBlockWithTxHashes", {
      block_id: { block_number: end },
    });
  }
  if (useFast)
    for (const collection of config.collections) {
      if (collection.startBlock > end) continue;
      const actual = await rpc.call("starknet_getClassHashAt", {
        block_id: { block_hash: anchor.block_hash },
        contract_address: collection.address,
      });
      const profile = historyProfiles(config).find((p) =>
        equal(p.address, collection.address),
      );
      if (
        ![profile.classHash, ...(profile.historicalClassHashes ?? [])].some(
          (hash) => equal(actual, hash),
        )
      )
        throw new ApiError(
          "CLASS_MISMATCH",
          "Historical collection class differs from the reviewed profile",
          503,
        );
    }
  // One shared events acquisition per window routes every collection (#114):
  // a single paged getEvents pass replaces one scan per collection; known
  // emitters feed coverage and unknown emitters become discovery candidates.
  const found = new Map();
  const unknownEmitters = new Map();
  const registry = new Map(
    allSources.map((source) => [source.address, source]),
  );
  const marketplace = config.marketplace ? address(config.marketplace) : null;
  let eventTotal = 0,
    eventScans = 0,
    malformedEmitters = 0;
  let cursor;
  const cursors = new Set();
  do {
    eventScans++;
    const page = await rpc.call(
      "starknet_getEvents",
      {
        filter: {
          from_block: { block_number: from },
          to_block: { block_number: end },
          keys: [],
          chunk_size: 500,
          ...(cursor ? { continuation_token: cursor } : {}),
        },
      },
      { endpoint: rpc.urls?.[0] },
    );
    if (!Array.isArray(page.events))
      throw new ApiError("INVALID_RPC_EVENTS", "Invalid event page.");
    for (const e of page.events) {
      if (e.block_number < from || e.block_number > end)
        throw new ApiError("INVALID_RPC_EVENTS", "Out-of-scope RPC event.");
      if (++eventTotal > maxWindowEvents)
        throw new ApiError(
          "WINDOW_EVENTS_DENSE",
          "Window event budget exceeded; reduce the scan window or raise maxWindowEvents",
          503,
        );
      let emitter;
      try {
        emitter = address(e.from_address);
      } catch {
        // Malformed emitter identities are isolated; acquisition continues.
        malformedEmitters++;
        continue;
      }
      const registered = registry.get(emitter);
      if (registered) {
        if (!sources.some((source) => source.address === emitter)) continue;
        if (e.block_number < registered.start) continue;
        const entries = found.get(e.block_number) ?? [];
        entries.push(e);
        found.set(e.block_number, entries);
      } else if (emitter !== marketplace) {
        if (unknownEmitters.has(emitter))
          unknownEmitters.set(
            emitter,
            Math.min(unknownEmitters.get(emitter), e.block_number),
          );
        else if (unknownEmitters.size < emitterBudget)
          unknownEmitters.set(emitter, e.block_number);
      }
    }
    cursor = page.continuation_token;
    if (cursor) {
      if (cursors.has(cursor))
        throw new ApiError("RPC_CURSOR_LOOP", "RPC repeated its cursor.");
      cursors.add(cursor);
    }
  } while (cursor);
  const anchorCheck = await rpc.call("starknet_getBlockWithTxHashes", {
    block_id: { block_number: end },
  });
  if (!equal(anchor.block_hash, anchorCheck.block_hash))
    throw new ApiError(
      "CHAIN_CONFLICT",
      "Scan range changed during acquisition.",
    );
  // Per-source ABI summaries (#112): decoded layouts are chosen by the class
  // pinned at the scan anchor. Missing context simply falls back to the
  // legacy fixed-order decode, so an unreachable ABI never blocks a scan.
  const decoderContext = await buildDecoderContext(
    store,
    rpc,
    sources,
    config,
    anchor.block_hash,
  );
  const prepare = (n, block) => {
    if (
      block.block_number !== n ||
      !["ACCEPTED_ON_L1", "ACCEPTED_ON_L2"].includes(block.status) ||
      !Array.isArray(block.transactions)
    )
      throw new ApiError(
        "INVALID_RPC_BLOCK",
        "Expected an accepted receipt block at the requested height.",
      );
    // Discard unrelated transactions immediately instead of retaining a whole
    // window of full receipt payloads. Defer decoding errors to the ordered writer.
    try {
      return {
        n,
        hash: block.block_hash,
        prepared: {
          ...prepareBlock(
            n,
            block,
            found,
            sources,
            config,
            observedAt,
            decoderContext,
          ),
          backfill: backfillMode,
        },
      };
    } catch (error) {
      return { n, hash: block.block_hash, error };
    }
  };
  const heights = useFast
    ? [...new Set([...found.keys(), end])].sort((a, b) => a - b)
    : Array.from({ length: end - from + 1 }, (_, i) => from + i);
  let blocks;
  if (receiptBatchSize > 1 && rpc.batch) {
    const groups = [];
    for (let i = 0; i < heights.length; i += receiptBatchSize)
      groups.push(heights.slice(i, i + receiptBatchSize));
    blocks = (
      await mapConcurrent(groups, receiptConcurrency, async (group) => {
        const receipts = await rpc.batch(
          group.map((n) => ({
            method: "starknet_getBlockWithReceipts",
            params: { block_id: { block_number: n } },
          })),
        );
        if (receipts.length !== group.length)
          throw new ApiError(
            "INVALID_RPC_BLOCK",
            "Missing receipt block in batch",
          );
        return receipts.map((block, i) => prepare(group[i], block));
      })
    ).flat();
  } else {
    blocks = await mapConcurrent(heights, receiptConcurrency, async (n) =>
      prepare(
        n,
        await rpc.call("starknet_getBlockWithReceipts", {
          block_id: { block_number: n },
        }),
      ),
    );
  }
  if (!equal(blocks.at(-1).hash, anchor.block_hash))
    throw new ApiError(
      "CHAIN_CONFLICT",
      "Range changed while reading receipts.",
    );
  const acquired = performance.now();
  let eventCount = 0;
  if (useFast) {
    for (const block of blocks) {
      if (block.error) throw block.error;
      eventCount += block.prepared.events.length;
    }
    await store.applyEventRange({
      from,
      to: end,
      blocks: blocks.map((b) => b.prepared),
      cutoff,
    });
  } else {
    let pending = [];
    const flush = async () => {
      if (store.applyBlocks) await store.applyBlocks(pending);
      else for (const b of pending) await store.applyBlock(b);
      pending = [];
    };
    for (const block of blocks) {
      if (block.error) {
        await flush();
        throw block.error;
      }
      pending.push(block.prepared);
      eventCount += block.prepared.events.length;
      if (pending.length >= commitBatchSize) await flush();
    }
    await flush();
  }
  // Unsupported collection events quarantine the collection instead of
  // stalling the scan or inventing state (#112). Raw rows are already in
  // chain.events, so this is a bounded catalog write.
  const quarantined = blocks.flatMap(
    (block) => block.prepared?.quarantined ?? [],
  );
  if (quarantined.length) {
    await recordQuarantine(store, config, quarantined);
    console.log(
      JSON.stringify({
        event: "decode_quarantine",
        at: new Date().toISOString(),
        indexed: end,
        count: quarantined.length,
        code: quarantined[0].code,
      }),
    );
  }
  // Unknown emitters observed in the shared stream become discovery
  // candidates, bounded by the emitter budget (#114).
  let candidatesCreated = 0;
  if (unknownEmitters.size) {
    const generation = await store.generation();
    for (const [emitter, block] of unknownEmitters) {
      const id = collectionKey(config.chainId, emitter);
      if (await store.get("catalog_collection", id)) continue;
      const canonical = await store.canonicalBlock(block);
      if (!canonical) continue; // reorged away; a later scan re-observes it
      const record = collectionRecord({
        chainId: config.chainId,
        address: emitter,
        ...emitterCandidateFields(),
        replayGeneration: generation,
      });
      await store.put("catalog_collection", record.id, record, block);
      candidatesCreated++;
    }
  }
  const finished = performance.now(),
    elapsedMs = Math.round(finished - started);
  return {
    indexed: end,
    head: latest.block_number,
    blocks: end - from + 1,
    receiptBlocks: blocks.length,
    mode: useFast ? "event_ranges" : "full_receipts",
    events: eventCount,
    elapsedMs,
    acquireMs: Math.round(acquired - started),
    rateLimitedResponses: (rpc.rateLimits ?? 0) - rateLimitsBefore,
    commitMs: Math.round(finished - acquired),
    blocksPerSecond: Number(
      (((end - from + 1) * 1000) / (finished - started)).toFixed(1),
    ),
    eventScans,
    unknownEmitters: unknownEmitters.size,
    candidatesCreated,
    malformedEmitters,
  };
}
export function prepareBlock(
  n,
  b,
  found,
  sources,
  config,
  observedAt,
  context = null,
) {
  const expected = found.get(n) ?? [];
  const active = new Set(
    sources.filter((s) => s.start <= n).map((s) => s.address),
  );
  const events = [],
    quarantined = [],
    actual = [];
  for (const entry of b.transactions) {
    const receipt = entry.receipt;
    if (!receipt || !Array.isArray(receipt.events))
      throw new ApiError("INVALID_RECEIPT", "Missing ordered receipt events.");
    const rawTransactionHash =
      receipt.transaction_hash ?? entry.transaction?.transaction_hash;
    const transactionHash = rawTransactionHash
      ? "0x" + BigInt(rawTransactionHash).toString(16)
      : null;
    if (!transactionHash)
      throw new ApiError(
        "INVALID_RECEIPT",
        "Receipt transaction identity missing.",
      );
    if (
      receipt.transaction_hash &&
      entry.transaction?.transaction_hash &&
      !equal(receipt.transaction_hash, entry.transaction.transaction_hash)
    )
      throw new ApiError(
        "INVALID_RECEIPT",
        "Conflicting transaction identity.",
      );
    if (receipt.execution_status === "REVERTED") continue;
    for (const [eventIndex, raw] of receipt.events.entries()) {
      const from = address(raw.from_address);
      if (!active.has(from)) continue;
      actual.push({ raw, tx: transactionHash });
      const marketSource =
        !!config.marketplace && from === address(config.marketplace);
      let event;
      try {
        event = decodeEvent(raw, config, context?.get(from) ?? null);
      } catch (error) {
        // Marketplace decode failures stay fatal; collection events are
        // quarantined with their raw row kept replayable (#112).
        if (marketSource) throw error;
        const code = error?.code ?? "DECODE_FAILED";
        const message = String(error?.message ?? error).slice(0, 200);
        quarantined.push({
          collection: from,
          block: n,
          transactionHash,
          eventIndex,
          code,
          message,
          selector: `0x${BigInt(raw.keys[0]).toString(16)}`,
        });
        events.push({
          type: "undecodable",
          collection: from,
          raw,
          transactionHash,
          eventIndex,
          decodeError: { code, message },
          decoderVersion: DECODER_CAPABILITY,
        });
        continue;
      }
      if (event) events.push({ ...event, raw, transactionHash, eventIndex });
    }
  }
  const a = actual.map((x) => `${BigInt(x.tx)}:${signature(x.raw)}`).sort(),
    e = expected
      .map((x) => `${BigInt(x.transaction_hash)}:${signature(x)}`)
      .sort();
  if (
    JSON.stringify(a) !== JSON.stringify(e) ||
    expected.some((e) => !equal(e.block_hash, b.block_hash))
  )
    throw new ApiError(
      "EVENT_COVERAGE",
      "Filtered events do not match full receipts.",
    );
  return {
    number: n,
    hash: b.block_hash,
    parentHash: b.parent_hash,
    timestamp: b.timestamp,
    events,
    sources: [...active],
    sourceStarts: Object.fromEntries(sources.map((s) => [s.address, s.start])),
    observedAt,
    quarantined,
  };
}

/** Pin class evidence per source at the scan anchor for decode adapters. */
async function buildDecoderContext(store, rpc, sources, config, blockHash) {
  const context = new Map();
  if (!store || typeof store.get !== "function" || !rpc) return context;
  const marketplace = config.marketplace ? address(config.marketplace) : null;
  for (const source of sources) {
    const normalized = address(source.address);
    if (normalized === marketplace) continue;
    try {
      const classHash = await rpc.call("starknet_getClassHashAt", {
        contract_address: normalized,
        block_id: { block_hash: blockHash },
      });
      let summary = await store.get("class_evidence", classHash);
      if (!summary) {
        const contractClass = await rpc.call("starknet_getClass", {
          class_hash: classHash,
          block_id: { block_hash: blockHash },
        });
        summary = summarizeAbi(contractClass?.abi ?? [], { classHash });
        await store.put("class_evidence", classHash, summary);
      }
      context.set(normalized, summary);
    } catch {
      // Context is strictly additive: a source without it decodes with the
      // legacy rules and can be retried on the next scan.
    }
  }
  return context;
}

/**
 * Persist bounded quarantine evidence on the collection record. First and
 * last are kept verbatim; observations counts evidence rows written, which
 * can include replays after a rewind (the catalog write is idempotent in
 * shape, never in invented state).
 */
export async function recordQuarantine(store, config, entries) {
  if (!Array.isArray(entries) || !entries.length) return 0;
  for (const entry of entries) {
    const id = collectionKey(config.chainId, entry.collection);
    let record = await store.get("catalog_collection", id);
    if (!record)
      record = collectionRecord({
        chainId: config.chainId,
        address: entry.collection,
        state: "unknown",
        standard: null,
        deployment: null,
        classHistory: [],
        classification: null,
        decoderVersion: null,
        replayGeneration: 1,
      });
    const evidence = {
      block: entry.block,
      transactionHash: entry.transactionHash,
      eventIndex: entry.eventIndex,
      code: entry.code,
      message: entry.message,
      selector: entry.selector,
    };
    const previous = record.quarantine ?? null;
    const quarantine = {
      observations: (previous?.observations ?? 0) + 1,
      first: previous?.first ?? evidence,
      last: evidence,
    };
    const body = collectionRecord({
      ...record,
      state: "failed",
      quarantine,
    });
    await store.put("catalog_collection", body.id, body, entry.block);
  }
  return entries.length;
}
