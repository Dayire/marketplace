import { ApiError, address } from "./domain.mjs";
import { scanOnce } from "./indexer.mjs";
import { indexingSource } from './source-config.mjs';
import { collectionKey, collectionRecord, sourceCoverage } from './collection-catalog.mjs';
import { reconcileCollection } from './legacy-coverage.mjs';

const eq = (a, b) => BigInt(a) === BigInt(b);
const JOB_STATES = ["pending", "running", "promoted", "failed"];
const bounded = (error) =>
  String(error?.message ?? error ?? "unknown error").slice(0, 300);

const isSafeBlock = (value) => Number.isSafeInteger(value) && value >= 0;

/** Job records are workflow state, not chain-derived: no rewind heights. */
export function backfillJob(value) {
  const id = String(value.id ?? "");
  if (!/^backfill:[0-9a-fx]+:0x[0-9a-f]+$/.test(id))
    throw new ApiError("INVALID_BACKFILL", "Invalid backfill job id");
  const chainId = String(value.chainId ?? "");
  if (!/^0x[0-9a-f]+$/.test(chainId))
    throw new ApiError("INVALID_BACKFILL", "Invalid backfill chain id");
  const collection = address(value.collection);
  const from = value.from,
    target = value.target,
    cursor = value.cursor;
  if (
    !isSafeBlock(from) ||
    !isSafeBlock(target) ||
    !Number.isSafeInteger(cursor) ||
    cursor < -1
  )
    throw new ApiError("INVALID_BACKFILL", "Invalid backfill block range");
  // The pinned target is immutable. A running job may catch up beyond it to
  // a newer live head before promotion; that does not replace its anchor.
  if (target < from || cursor < Math.max(from - 1, -1))
    throw new ApiError("INVALID_BACKFILL", "Backfill cursor outside range");
  if (!value.targetHash || typeof value.targetHash !== "string")
    throw new ApiError("INVALID_BACKFILL", "Backfill requires a pinned anchor");
  const state = value.state;
  if (!JOB_STATES.includes(state))
    throw new ApiError("INVALID_BACKFILL", "Invalid backfill state");
  const error = value.error == null ? null : String(value.error).slice(0, 300);
  return {
    id,
    chainId,
    collection,
    from,
    target,
    targetHash: value.targetHash,
    cursor,
    state,
    error,
    createdAt: Number.isSafeInteger(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: Number.isSafeInteger(value.updatedAt) ? value.updatedAt : Date.now(),
  };
}

const jobId = (chainId, collection) =>
  `backfill:${chainId}:${address(collection)}`;

/**
 * Register a bounded backfill for one registered collection. The target must
 * already be canonical in the journal; promotion re-validates it (#113).
 */
export async function enqueueBackfill(store, config, { collection, target, allowConcurrent = false }) {
  const entry = await indexingSource(store, config, collection);
  if (!entry)
    throw new ApiError(
      "BACKFILL_REGISTRY",
      "Backfill target is not a registered collection",
      409,
    );
  if (!isSafeBlock(target))
    throw new ApiError("BACKFILL_ANCHOR", "Invalid backfill target", 409);
  const canonical = await store.canonicalBlock(target);
  if (!canonical)
    throw new ApiError(
      "BACKFILL_ANCHOR",
      "Backfill target is not a canonical anchor",
      409,
    );
  const existing = await store.get("backfill_job", jobId(config.chainId, entry.address));
  if (existing && ['pending', 'running'].includes(existing.state)) return existing;
  const running = (await store.list("backfill_job")).find(
    (job) => job.state === "running" || job.state === "pending",
  );
  if (running && !allowConcurrent)
    throw new ApiError(
      "BACKFILL_BUSY",
      `Overlapping backfill job ${running.id} is active`,
      409,
    );
  const now = Date.now();
  const job = backfillJob({
    id: jobId(config.chainId, entry.address),
    chainId: config.chainId,
    collection: entry.address,
    from: entry.startBlock,
    target,
    targetHash: canonical.hash,
    cursor: Math.max(entry.startBlock - 1, -1),
    state: "pending",
    error: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  await store.put("backfill_job", job.id, job);
  return job;
}

/**
 * Run every active backfill to promotion. Crashes persist the cursor, a
 * failing job is marked failed without stopping the others, and promotion
 * only fires once the pinned anchor and live head both validate canonically.
 */
export async function runBackfill(store, rpc, config, options = {}) {
  const { window = 100, maxRounds = 500, lease = true, yieldAfterRound = false, limit = 100 } = options;
  if (!Number.isSafeInteger(window) || window < 1 || window > 1000)
    throw new ApiError("INVALID_WINDOW", "Backfill window must be 1-1000 blocks.");
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 10000
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new ApiError('INVALID_WINDOW', 'Invalid bounded backfill round/job budget');
  let release = null;
  if (lease && store.acquireIndexerLease) {
    try {
      release = await store.acquireIndexerLease();
    } catch (error) {
      return { skipped: "lease", reason: bounded(error), jobs: [] };
    }
  }
  try {
    const jobs = (await store.list("backfill_job")).filter((job) =>
      ["pending", "running"].includes(job.state),
    );
    // Oldest attempted jobs rotate to the tail; a failing collection cannot
    // consume every writer cycle or starve the shared live scanner.
    jobs.sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
    const results = [];
    for (const job of jobs.slice(0, limit)) {
      try {
        const source = await indexingSource(store, config, job.collection);
        if (!source) throw new ApiError('BACKFILL_REGISTRY', 'Collection no longer has supported indexing evidence');
        const scoped = { ...config, collections: [...(config.collections ?? []).filter(c => address(c.address) !== address(source.address)), source] };
        results.push(await runJob(store, rpc, scoped, job, window, maxRounds, yieldAfterRound));
      } catch (error) {
        const persisted = await store.get('backfill_job', job.id);
        const failed = backfillJob({
          ...(persisted ?? job),
          state: "failed",
          error: bounded(error),
          updatedAt: Date.now(),
        });
        await store.put("backfill_job", failed.id, failed);
        results.push({ id: failed.id, state: "failed", error: failed.error });
      }
    }
    return {
      jobs: results,
      promoted: results.filter((r) => r.state === "promoted").length,
      failed: results.filter((r) => r.state === "failed").length,
    };
  } finally {
    if (release) await release();
  }
}

async function runJob(store, rpc, config, job, window, maxRounds, yieldAfterRound) {
  let current = backfillJob({ ...job, state: "running", updatedAt: Date.now() });
  // Workflow records survive a chain rewind; source progress does not. Resume
  // from the canonical projection rather than trusting the old workflow cursor.
  const progress = await store.get('progress', address(current.collection));
  const checkpoint = progress && await store.canonicalBlock(progress.block);
  if (!checkpoint || BigInt(checkpoint.hash) !== BigInt(progress.hash))
    current = backfillJob({ ...current, cursor: Math.max(current.from - 1, -1) });
  else if (Number.isSafeInteger(progress.startBlock) && progress.startBlock <= current.from)
    current = backfillJob({ ...current, cursor: Math.max(current.from - 1, progress.block) });
  await store.put("backfill_job", current.id, current);
  let rounds = 0;
  for (;;) {
    const head = await store.head();
    if (!head)
      throw new ApiError(
        "BACKFILL_ANCHOR",
        "Backfill requires an indexed canonical head",
      );
    const scope = [current.collection];
    if (current.cursor < head.number) {
      if (rounds >= maxRounds) {
        if (yieldAfterRound) return { id: current.id, state: 'running', cursor: current.cursor };
        throw new ApiError('BACKFILL_ROUNDS', 'Backfill exceeded its bounded round budget');
      }
      rounds++;
    }
    if (current.cursor < current.target && current.cursor < head.number) {
      // Pinned-anchor phase: overlay from the cursor to the target anchor.
      const to = Math.min(current.cursor + window, current.target, head.number);
      await scanOnce(store, rpc, config, {
        window: to - current.cursor,
        from: current.cursor + 1,
        stopAt: to,
        scope,
        backfillAnchor: { number: current.target, hash: current.targetHash },
      });
      current = backfillJob({ ...current, cursor: to, updatedAt: Date.now() });
      await store.put("backfill_job", current.id, current);
      continue;
    }
    if (current.cursor < head.number) {
      // Catch-up phase: close the remaining gap to the live head (#113).
      const to = Math.min(current.cursor + window, head.number);
      await scanOnce(store, rpc, config, {
        window: to - current.cursor,
        from: current.cursor + 1,
        stopAt: to,
        scope,
      });
      current = backfillJob({ ...current, cursor: to, updatedAt: Date.now() });
      await store.put("backfill_job", current.id, current);
      continue;
    }
    // Promotion: pinned anchor must still be canonical on disk and on chain.
    const stored = await store.canonicalBlock(current.target);
    if (!stored || !eq(stored.hash, current.targetHash))
      throw new ApiError(
        "BACKFILL_ANCHOR",
        "Pinned target anchor is no longer canonical",
        409,
      );
    const onChain = await rpc.call("starknet_getBlockWithTxHashes", {
      block_id: { block_number: current.target },
    });
    if (!eq(onChain.block_hash, current.targetHash))
      throw new ApiError(
        "BACKFILL_ANCHOR",
        "Pinned target anchor changed on chain",
        409,
      );
    const progress = await store.get(
      "progress",
      address(current.collection),
    );
    if (
      !progress ||
      progress.block !== head.number ||
      !eq(progress.hash, head.hash) ||
      !Number.isSafeInteger(progress.startBlock) || progress.startBlock > current.from
    )
      throw new ApiError(
        "BACKFILL_INCOMPLETE",
        "Source checkpoint does not cover the canonical head",
        409,
      );
    const record = await store.get('catalog_collection', collectionKey(config.chainId, current.collection));
    if (record?.quarantine || record?.state === 'failed')
      throw new ApiError('BACKFILL_QUARANTINED', 'Raw collection history contains unresolved decoder evidence', 409);
    const source = config.collections.find(c => address(c.address) === current.collection);
    if (source?.indexingOnly) {
      const reconciliation = await reconcileCollection(store, rpc, config, {
        collection: current.collection, blockNumber: head.number, blockHash: head.hash, limit: 25,
      });
      if (!reconciliation.ok)
        throw new ApiError('BACKFILL_RECONCILIATION', 'Pinned ownership or balance reconciliation is unavailable or mismatched', 409);
    }
    current = backfillJob({
      ...current,
      state: "promoted",
      error: null,
      updatedAt: Date.now(),
    });
    const generation = await store.generation();
    const coverage = sourceCoverage({
      chainId: config.chainId, address: current.collection, sourceType: 'nft', mode: source?.indexingOnly ? 'catalog' : 'configured_scan',
      startBlock: current.from, block: head.number, hash: head.hash, observedAt: progress.observedAt,
      replayGeneration: generation, gaps: [],
    });
    const writes = [
      ['backfill_job', current.id, current, null],
      ...(record ? [['catalog_collection', record.id, collectionRecord({ ...record, state: 'indexed', replayGeneration: generation }), head.number]] : []),
      ['source_coverage', coverage.id, coverage, head.number],
    ];
    if (store.dialect === 'postgres') await store.transaction(async () => {
      for (const [kind, id, body, height] of writes) await store.put(kind, id, body, height);
    });
    else store.snapshot(() => { for (const [kind, id, body, height] of writes) store.put(kind, id, body, height); });
    return { id: current.id, state: "promoted", cursor: current.cursor };
  }
}
