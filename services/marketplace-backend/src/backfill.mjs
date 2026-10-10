import { ApiError, address } from "./domain.mjs";
import { scanOnce } from "./indexer.mjs";

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
  if (target < from || cursor > target)
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
export async function enqueueBackfill(store, config, { collection, target }) {
  const entry = (config.collections ?? []).find(
    (c) => address(c.address) === address(collection),
  );
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
  const running = (await store.list("backfill_job")).find(
    (job) => job.state === "running" || job.state === "pending",
  );
  if (running)
    throw new ApiError(
      "BACKFILL_BUSY",
      `Overlapping backfill job ${running.id} is active`,
      409,
    );
  const existing = await store.get("backfill_job", jobId(config.chainId, entry.address));
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
  const { window = 100, maxRounds = 500, lease = true } = options;
  if (!Number.isSafeInteger(window) || window < 1 || window > 1000)
    throw new ApiError("INVALID_WINDOW", "Backfill window must be 1-1000 blocks.");
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
    const results = [];
    for (const job of jobs) {
      try {
        results.push(await runJob(store, rpc, config, job, window, maxRounds));
      } catch (error) {
        const failed = backfillJob({
          ...job,
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

async function runJob(store, rpc, config, job, window, maxRounds) {
  let current = backfillJob({ ...job, state: "running", updatedAt: Date.now() });
  await store.put("backfill_job", current.id, current);
  let rounds = 0;
  for (;;) {
    if (++rounds > maxRounds)
      throw new ApiError(
        "BACKFILL_ROUNDS",
        "Backfill exceeded its bounded round budget",
      );
    const head = await store.head();
    if (!head)
      throw new ApiError(
        "BACKFILL_ANCHOR",
        "Backfill requires an indexed canonical head",
      );
    const scope = [current.collection];
    if (current.cursor < current.target && current.cursor < head.number) {
      // Pinned-anchor phase: overlay from the cursor to the target anchor.
      const to = Math.min(current.cursor + window, current.target, head.number);
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
      !eq(progress.hash, head.hash)
    )
      throw new ApiError(
        "BACKFILL_INCOMPLETE",
        "Source checkpoint does not cover the canonical head",
        409,
      );
    current = backfillJob({
      ...current,
      state: "promoted",
      error: null,
      updatedAt: Date.now(),
    });
    await store.put("backfill_job", current.id, current);
    return { id: current.id, state: "promoted", cursor: current.cursor };
  }
}
