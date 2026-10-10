import { ApiError, address } from "./domain.mjs";
import { mapConcurrent } from "./concurrency.mjs";
import {
  collectionKey,
  collectionRecord,
  sourceCoverage,
} from "./collection-catalog.mjs";
import {
  DISCOVERY_ADDRESS,
  discoveryKey,
  emitterCandidateFields,
  mergeDiscovery,
  normalizeStateUpdate,
  planDiscoveryRange,
} from "./discovery.mjs";

const equal = (a, b) => BigInt(a) === BigInt(b);
const BLOCK_NOT_FOUND = 24;
const rpcCodeOf = (error) =>
  error?.details?.rpcCode ?? (typeof error?.code === "number" ? error.code : null);
const isBlockNotFound = (error) =>
  rpcCodeOf(error) === BLOCK_NOT_FOUND ||
  (error?.code === "RPC_CONTRACT_ERROR" && /block not found/i.test(error.message ?? ""));
const isUnsupportedMethod = (error) => [-32601, -32600].includes(rpcCodeOf(error));
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Probe state-update availability. A missing history prefix is a recorded gap,
 * never a claim of completeness: the floor is the lowest block this RPC serves.
 */
export async function probeStateHistory(
  rpc,
  { earliest = 0, head, probes = 6 } = {},
) {
  if (
    !Number.isSafeInteger(earliest) ||
    earliest < 0 ||
    !Number.isSafeInteger(head) ||
    head < 0 ||
    earliest > head
  )
    throw new ApiError("INVALID_WINDOW", "Invalid discovery probe range.");
  if (!Number.isInteger(probes) || probes < 0 || probes > 16)
    throw new ApiError("INVALID_WINDOW", "Probe attempts must be an integer 0–16.");
  let used = 0;
  const attempt = async (block) => {
    used++;
    try {
      await rpc.call("starknet_getStateUpdate", { block_id: { block_number: block } });
      return true;
    } catch (error) {
      if (isBlockNotFound(error)) return false;
      if (isUnsupportedMethod(error))
        throw new ApiError(
          "DISCOVERY_UNSUPPORTED",
          "RPC cannot serve starknet_getStateUpdate; discovery cannot claim coverage.",
          503,
        );
      throw error;
    }
  };
  if (await attempt(earliest))
    return {
      supported: true,
      floorBlock: earliest,
      gapTo: null,
      probesUsed: used,
      observedAt: Date.now(),
    };
  if (!(await attempt(head)))
    return {
      supported: false,
      reason: "STATE_UPDATE_UNAVAILABLE_AT_HEAD",
      floorBlock: null,
      gapTo: null,
      probesUsed: used,
      observedAt: Date.now(),
    };
  let lo = earliest, hi = head;
  while (hi - lo > 1 && used <= probes) {
    const mid = Math.floor((lo + hi) / 2);
    if (await attempt(mid)) hi = mid;
    else lo = mid;
  }
  return {
    supported: true,
    floorBlock: hi,
    gapTo: hi > earliest ? hi - 1 : null,
    probesUsed: used,
    observedAt: Date.now(),
  };
}

/** One bounded discovery pass: verify the checkpoint (rewinding a reorg),
 * walk accepted state updates, supplement emitter candidates, then commit
 * anchors, catalog facts and the coverage checkpoint in ONE transaction.
 */
export async function discoverOnce(store, rpc, config, options = {}) {
  const opts = {
    span: options.span ?? 100,
    concurrency: options.concurrency ?? 4,
    stopAt: options.stopAt ?? null,
    emitters: options.emitters ?? true,
    emitterBudget: options.emitterBudget ?? 2000,
    probes: options.probes ?? 6,
    earliest: options.earliest ?? 0,
    maxRewind: options.maxRewind ?? 100,
  };
  for (const [value, label, max] of [
    [opts.concurrency, "concurrency", 32],
    [opts.emitterBudget, "emitter budget", 100000],
    [opts.maxRewind, "max rewind", 10000],
    [opts.probes, "probes", 16],
  ])
    if (!Number.isInteger(value) || value < 0 || value > max)
      throw new ApiError("INVALID_WINDOW", `Invalid discovery ${label}.`);
  if (!opts.concurrency) throw new ApiError("INVALID_WINDOW", "Invalid discovery concurrency.");
  const started = performance.now(),
    key = discoveryKey(config.chainId);
  if (!equal(await rpc.call("starknet_chainId", []), config.chainId))
    throw new ApiError("CHAIN_MISMATCH", "RPC is on another chain.");
  const latest = await rpc.call("starknet_getBlockWithTxHashes", { block_id: "latest" });
  if (!["ACCEPTED_ON_L1", "ACCEPTED_ON_L2"].includes(latest.status))
    throw new ApiError("UNACCEPTED_HEAD", "RPC head is not accepted.");
  const head = latest.block_number;
  let coverage = await store.get("source_coverage", key),
    rewound = null;
  if (coverage?.block != null) {
    const canonical = await rpc.call("starknet_getBlockWithTxHashes", {
      block_id: { block_number: coverage.block },
    });
    if (!equal(canonical.block_hash, coverage.hash)) {
      const floor = Math.max(
        coverage.startBlock ?? 0,
        coverage.block - opts.maxRewind,
      );
      let ancestor = null;
      for (let n = coverage.block - 1; n >= floor; n--) {
        const anchor = await store.get("discovery_anchor", String(n));
        if (!anchor) continue;
        const block = await rpc.call("starknet_getBlockWithTxHashes", {
          block_id: { block_number: n },
        });
        if (equal(anchor.hash, block.block_hash)) {
          ancestor = n;
          break;
        }
      }
      if (ancestor == null) ancestor = floor - 1;
      await store.rewind(ancestor);
      rewound = ancestor;
      coverage = await store.get("source_coverage", key);
    }
  }
  // startBlock is the requested coverage start (published honestly); walkFloor is
  // where this RPC can actually serve state updates.
  let startBlock = coverage?.startBlock ?? opts.earliest,
    walkFloor = coverage?.startBlock ?? opts.earliest;
  const gaps = (coverage?.gaps ?? []).map((gap) => ({ ...gap }));
  if (coverage == null) {
    const probe = await probeStateHistory(rpc, {
      earliest: opts.earliest,
      head,
      probes: opts.probes,
    });
    await store.put("status", "discovery_probe", probe);
    if (!probe.supported)
      throw new ApiError(
        "DISCOVERY_UNSUPPORTED",
        "State updates are unavailable at this RPC head; discovery cannot claim coverage.",
        503,
      );
    startBlock = opts.earliest;
    walkFloor = Math.max(opts.earliest, probe.floorBlock);
    if (probe.gapTo != null)
      gaps.push({
        from: opts.earliest,
        to: probe.gapTo,
        reason: `STATE_HISTORY_UNAVAILABLE before provider floor block ${probe.floorBlock}`,
      });
  }
  const plan = planDiscoveryRange({
    checkpoint: coverage?.block ?? null,
    earliest: walkFloor,
    head,
    span: opts.span,
    stopAt: opts.stopAt,
  });
  if (!plan)
    return {
      caughtUp: true,
      head,
      checkpoint: coverage ? { block: coverage.block, hash: coverage.hash } : null,
      rewound,
    };
  const updates = await mapConcurrent(
    range(plan.from, plan.to),
    opts.concurrency,
    async (block) => {
      try {
        return { block, update: await rpc.call("starknet_getStateUpdate", { block_id: { block_number: block } }) };
      } catch (error) {
        if (isBlockNotFound(error)) return { block, missing: true };
        throw error;
      }
    },
  );
  const facts = new Map(),
    hashByBlock = new Map(),
    missing = [];
  let deployed = 0,
    replaced = 0;
  for (const { block, update, missing: absent } of updates) {
    if (absent) {
      missing.push(block);
      continue;
    }
    const normalized = normalizeStateUpdate(block, update);
    hashByBlock.set(block, normalized.hash);
    for (const value of normalized.deployments) {
      deployed++;
      const events = facts.get(value.address) ?? [];
      events.push({ block, hash: normalized.hash, kind: "deploy", classHash: value.classHash });
      facts.set(value.address, events);
    }
    for (const value of normalized.replacements) {
      replaced++;
      const events = facts.get(value.address) ?? [];
      events.push({ block, hash: normalized.hash, kind: "replace", classHash: value.classHash });
      facts.set(value.address, events);
    }
  }
  for (const run of collapse(missing))
    gaps.push({
      from: run[0],
      to: run.at(-1),
      reason: "STATE_HISTORY_UNAVAILABLE during walk (provider returned block-not-found)",
    });
  const anchorCheck = await rpc.call("starknet_getBlockWithTxHashes", {
    block_id: { block_number: plan.to },
  });
  if (!hashByBlock.has(plan.to)) hashByBlock.set(plan.to, anchorCheck.block_hash);
  else if (!equal(hashByBlock.get(plan.to), anchorCheck.block_hash))
    throw new ApiError("CHAIN_CONFLICT", "Chain changed during discovery acquisition.", 409);
  const emitters = new Map();
  let eventsScanned = 0,
    emitterIncomplete = null;
  if (opts.emitters) {
    try {
      let cursor;
      const cursors = new Set();
      do {
        const page = await rpc.call("starknet_getEvents", {
          filter: {
            from_block: { block_number: plan.from },
            to_block: { block_number: plan.to },
            keys: [],
            chunk_size: 500,
            ...(cursor ? { continuation_token: cursor } : {}),
          },
        });
        if (!Array.isArray(page.events))
          throw new ApiError("INVALID_RPC_EVENTS", "Invalid event page.");
        for (const event of page.events) {
          if (eventsScanned >= opts.emitterBudget) {
            emitterIncomplete = {
              from: plan.from,
              to: plan.to,
              reason: "EMITTER_SCAN_BUDGET_EXCEEDED",
            };
            break;
          }
          eventsScanned++;
          try {
            const emitter = address(event.from_address),
              block = Number(event.block_number);
            if (!Number.isSafeInteger(block) || block < plan.from || block > plan.to)
              throw new ApiError("INVALID_RPC_EVENTS", "Out-of-scope emitter event.");
            if (emitter === address(config.marketplace ?? "0x0")) continue;
            emitters.set(emitter, Math.min(emitters.get(emitter) ?? block, block));
          } catch (error) {
            if (error.code === "INVALID_RPC_EVENTS") throw error;
            // Malformed emitter identities are isolated; state discovery continues.
          }
        }
        cursor = page.continuation_token;
        if (cursor && cursors.has(cursor))
          throw new ApiError("RPC_CURSOR_LOOP", "RPC repeated its cursor.");
        if (cursor) cursors.add(cursor);
      } while (cursor && !emitterIncomplete);
    } catch (error) {
      if (!isBlockNotFound(error) && error.code !== "INVALID_RPC_EVENTS") throw error;
      emitterIncomplete = {
        from: plan.from,
        to: plan.to,
        reason: `EMITTER_SCAN_FAILED:${error.code ?? "RPC_ERROR"}`,
      };
    }
  }
  const payload = {
    chainId: config.chainId,
    facts,
    emitters,
    walk: { from: plan.from, to: plan.to, hashByBlock },
    gaps: dedupeGaps(gaps),
    startBlock,
    observedAt: Date.now(),
    head,
  };
  const read = async () => ({
    generation: await store.generation(),
    records: new Map(
      await Promise.all(
        [...new Set([...facts.keys(), ...emitters.keys()])].map(async (value) => [
          value,
          await store.get("catalog_collection", collectionKey(config.chainId, value)),
        ]),
      ),
      ),
    canonical: new Map(
      await Promise.all(
        [...new Set([...facts.keys()].flatMap((value) => facts.get(value).map((e) => e.block)).concat(plan.to))].map(
          async (block) => [block, await store.canonicalBlock(block)],
        ),
      ),
    ),
  });
  const apply = async (reads) => {
    for (const op of planDiscoveryOps(reads, payload))
      await store.put(op.kind, op.id, op.body, op.height);
  };
  if (store.dialect === "postgres") await store.transaction(async () => apply(await read()));
  else {
    const reads = await read();
    store.snapshot(() => {
      for (const op of planDiscoveryOps(reads, payload))
        store.put(op.kind, op.id, op.body, op.height);
    });
  }
  if (emitterIncomplete) {
    const probe = (await store.get("status", "discovery_probe")) ?? { supported: true };
    const remaining = (probe.emittersIncomplete ?? []).filter(
      (entry) => !(entry.from >= plan.from && entry.to <= plan.to),
    );
    remaining.push(emitterIncomplete);
    await store.put("status", "discovery_probe", {
      ...probe,
      emittersIncomplete: remaining.slice(-10),
    });
  }
  return {
    from: plan.from,
    to: plan.to,
    head,
    deployed,
    replaced,
    candidates: emitters.size,
    events: eventsScanned,
    gaps: payload.gaps.length,
    emittersIncomplete: emitterIncomplete,
    rewound,
    elapsedMs: Math.round(performance.now() - started),
  };
}

/** Pure: reads + walk results → ordered store writes. Conflicts fail before any write. */
function planDiscoveryOps(reads, payload) {
  const { chainId, facts, emitters, walk, gaps, startBlock, observedAt } = payload;
  const generation = reads.generation,
    ops = [];
  const conflict = (block, expected) => {
    const canonical = reads.canonical.get(block)?.hash ?? null;
    if (canonical != null && !equal(canonical, expected))
      throw new ApiError(
        "CHAIN_CONFLICT",
        `Discovery evidence for block ${block} disagrees with the canonical journal.`,
        409,
      );
  };
  for (const events of facts.values())
    for (const event of events) conflict(event.block, event.hash);
  conflict(walk.to, walk.hashByBlock.get(walk.to));
  const created = new Set();
  for (const [value, events] of facts) {
    const previous = reads.records.get(value) ?? null,
      record = collectionRecord({
        ...previous,
        ...mergeDiscovery(previous, events),
        chainId,
        address: value,
        replayGeneration: generation,
      });
    ops.push({
      kind: "catalog_collection",
      id: record.id,
      body: record,
      height: Math.min(...events.map((event) => event.block)),
    });
    created.add(value);
  }
  for (const [value, block] of emitters) {
    if (created.has(value) || reads.records.get(value)) continue;
    const record = collectionRecord({
      chainId,
      address: value,
      ...emitterCandidateFields(),
      replayGeneration: generation,
    });
    ops.push({ kind: "catalog_collection", id: record.id, body: record, height: block });
  }
  const coverage = sourceCoverage({
    chainId,
    address: DISCOVERY_ADDRESS,
    sourceType: "discovery",
    mode: "catalog",
    startBlock,
    block: walk.to,
    hash: walk.hashByBlock.get(walk.to),
    observedAt,
    replayGeneration: generation,
    gaps,
  });
  ops.push({ kind: "source_coverage", id: coverage.id, body: coverage, height: walk.to });
  for (const [block, hash] of walk.hashByBlock)
    ops.push({
      kind: "discovery_anchor",
      id: String(block),
      body: { block, hash },
      height: block,
    });
  return ops;
}

function collapse(blocks) {
  const runs = [];
  for (const block of blocks) {
    const last = runs.at(-1);
    if (last && block === last.at(-1) + 1) last.push(block);
    else runs.push([block]);
  }
  return runs;
}

function dedupeGaps(gaps) {
  const seen = new Set(),
    unique = [];
  for (const gap of gaps) {
    const id = `${gap.from}:${gap.to}:${gap.reason}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(gap);
  }
  if (unique.length <= 100) return unique;
  const dropped = unique.slice(99),
    from = Math.min(...dropped.map((gap) => gap.from)),
    to = Math.max(...dropped.map((gap) => gap.to));
  return [
    ...unique.slice(0, 99),
    { from, to, reason: `AGGREGATED_HISTORY_GAPS (${dropped.length} regions)` },
  ];
}
