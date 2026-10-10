/** HTTP concurrency counts batches, not individual block lookups within them. */
export function indexerOptions(env = process.env) {
  const read = integerReader(env);
  return {
    fastHistory: env.MARKETPLACE_INDEX_FAST_HISTORY === "true",
    historyWindow: read("MARKETPLACE_INDEX_HISTORY_WINDOW", 100000, 100000),
    window: read("MARKETPLACE_INDEX_WINDOW", 1000, 1000),
    receiptConcurrency: read("MARKETPLACE_INDEX_CONCURRENCY", 8, 32),
    receiptBatchSize: read("MARKETPLACE_INDEX_RPC_BATCH", 1, 32),
    commitBatchSize: read("MARKETPLACE_INDEX_COMMIT_BATCH", 250, 1000),
    maxWindowEvents: read("MARKETPLACE_INDEX_WINDOW_EVENT_BUDGET", 50000, 1000000, 100),
    emitterBudget: read("MARKETPLACE_INDEX_EMITTER_BUDGET", 500, 100000, 10),
  };
}

function integerReader(env) {
  return (name, fallback, maximum, minimum = 1) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
    return value;
  };
}

/** Discovery is bounded per pass; spans are state-update calls, one per block. */
export function discoveryOptions(env = process.env) {
  const read = integerReader(env);
  return {
    span: read("MARKETPLACE_DISCOVERY_SPAN", 100, 2000),
    concurrency: read("MARKETPLACE_DISCOVERY_CONCURRENCY", 4, 32),
    emitters: env.MARKETPLACE_DISCOVERY_EMITTERS !== "false",
    emitterBudget: read("MARKETPLACE_DISCOVERY_EMITTER_BUDGET", 2000, 100000),
    probes: read("MARKETPLACE_DISCOVERY_PROBES", 6, 16),
    earliest: read("MARKETPLACE_DISCOVERY_EARLIEST", 0, 9007199254740991, 0),
    maxRewind: read("MARKETPLACE_DISCOVERY_MAX_REWIND", 100, 10000),
  };
}

/** One writer interleaves enrichment with live indexing; work is bounded per cycle. */
export function catalogOptions(env = process.env) {
  const read = integerReader(env);
  return {
    live: indexerOptions({ ...env, MARKETPLACE_INDEX_WINDOW: env.MARKETPLACE_INDEX_WINDOW ?? '16', MARKETPLACE_INDEX_FAST_HISTORY: 'false' }),
    discovery: discoveryOptions({ ...env, MARKETPLACE_DISCOVERY_SPAN: env.MARKETPLACE_DISCOVERY_SPAN ?? '16', MARKETPLACE_DISCOVERY_EMITTERS: env.MARKETPLACE_DISCOVERY_EMITTERS ?? 'false' }),
    classify: { limit: read('MARKETPLACE_CATALOG_CLASSIFY_LIMIT', 8, 500), concurrency: read('MARKETPLACE_CATALOG_CLASSIFY_CONCURRENCY', 2, 32) },
    backfill: { window: read('MARKETPLACE_CATALOG_BACKFILL_WINDOW', 4, 1000) },
    queueLimit: read('MARKETPLACE_CATALOG_QUEUE_LIMIT', 8, 100),
  };
}
