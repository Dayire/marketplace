import { address, ApiError } from './domain.mjs';
import { scanOnce } from './indexer.mjs';
import { discoverOnce } from './discovery-scan.mjs';
import { classifyOnce } from './classify-scan.mjs';
import { enqueueBackfill, runBackfill } from './backfill.mjs';
import { indexingSource, liveIndexingConfig } from './source-config.mjs';
import { collectionRecord } from './collection-catalog.mjs';

const eq = (a, b) => BigInt(a) === BigInt(b);
const accepted = block => ['ACCEPTED_ON_L1', 'ACCEPTED_ON_L2'].includes(block.status);
const budget = (value, max, label) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new ApiError('INVALID_WINDOW', `Invalid catalog ${label} budget`);
  return value;
};

/** Caller owns the single chain-writer lease for the complete ordered cycle.
 * Healthy live sources run first. Enrichment is bounded, persistent and local
 * to each source; it never expands the settlement registry.
 */
export async function runIndexingCycle(store, rpc, config, options = {}) {
  const live = { window: 16, ...options.live, fastHistory: false };
  const discovery = { span: 16, concurrency: 4, emitters: false, ...options.discovery };
  const classify = { limit: 8, concurrency: 2, ...options.classify };
  const queueLimit = budget(options.queueLimit ?? 8, 100, 'queue');
  // Historical blocks can require many unfiltered event pages. Keep the
  // default slice small so each complete slice yields to the live scanner.
  const backfill = { window: 4, ...options.backfill, maxRounds: 1, limit: 1, yieldAfterRound: true, lease: false };
  budget(live.window, 1000, 'live window');
  budget(backfill.window, 1000, 'backfill window');
  const result = {};
  const liveConfig = await liveIndexingConfig(store, config);
  result.live = liveConfig.collections.length || config.marketplace
    ? await scanOnce(store, rpc, liveConfig, live)
    : await scanHeaders(store, rpc, config, live.window);
  const local = async (name, run) => {
    try {
      const value = await run();
      await store.put('status', `catalog_cycle:${name}`, { observedAt: Date.now(), error: null });
      return value;
    } catch (error) {
      if (error.code === 'INDEXER_LEASE_LOST' || store.lease?.lost) throw error;
      const value = { error: error.code ?? 'CATALOG_ERROR', message: String(error.message).slice(0, 300) };
      await store.put('status', `catalog_cycle:${name}`, { ...value, observedAt: Date.now() });
      return value;
    }
  };
  result.discovery = await local('discovery', () => discoverOnce(store, rpc, config, discovery));
  result.classification = await local('classification', () => classifyOnce(store, rpc, config, classify));
  result.queue = await local('queue', async () => {
    const head = await store.head();
    if (!head) return { queued: 0 };
    const jobs = new Map((await store.list('backfill_job')).map(job => [address(job.collection), job]));
    let queued = 0;
    for (const record of await store.list('catalog_collection')) {
      if (queued >= queueLimit) break;
      if (config.collections.some(source => address(source.address) === record.address)) continue;
      const source = await indexingSource(store, config, record.address);
      if (!source || source.startBlock > head.number) continue;
      const old = jobs.get(source.address);
      if (old && ['pending', 'running', 'failed'].includes(old.state)) continue;
      const progress = await store.get('progress', source.address);
      if (old?.state === 'promoted' && progress?.block === head.number && eq(progress.hash, head.hash)
          && progress.startBlock <= source.startBlock) continue;
      await enqueueBackfill(store, config, { collection: source.address, target: head.number, allowConcurrent: true });
      await store.put('catalog_collection', record.id, collectionRecord({ ...record, state: 'syncing' }), head.number);
      queued++;
    }
    return { queued };
  });
  result.backfill = await local('backfill', () => runBackfill(store, rpc, config, backfill));
  result.indexed = (await store.head())?.number ?? null;
  result.head = result.live.head;
  return result;
}

/** Headers authorize only the journal anchor. They claim no NFT coverage. */
async function scanHeaders(store, rpc, config, window) {
  await store.bindIdentity({ chainId: '0x' + BigInt(config.chainId).toString(16), marketplace: null });
  if (!eq(await rpc.call('starknet_chainId', []), config.chainId))
    throw new ApiError('CHAIN_MISMATCH', 'RPC is on another chain');
  const latest = await rpc.call('starknet_getBlockWithTxHashes', { block_id: 'latest' });
  if (!accepted(latest)) throw new ApiError('UNACCEPTED_HEAD', 'RPC head is not accepted');
  let head = await store.head();
  while (head) {
    const canonical = await rpc.call('starknet_getBlockWithTxHashes', { block_id: { block_number: head.number } });
    if (eq(canonical.block_hash, head.hash)) break;
    await store.rewind(head.number - 1); head = await store.head();
  }
  const from = head ? head.number + 1 : latest.block_number;
  const to = Math.min(latest.block_number, from + window - 1);
  for (let n = from; n <= to; n++) {
    const block = n === latest.block_number ? latest
      : await rpc.call('starknet_getBlockWithTxHashes', { block_id: { block_number: n } });
    if (block.block_number !== n || !accepted(block)) throw new ApiError('INVALID_RPC_BLOCK', 'Invalid accepted header');
    await store.applyBlock({ number: n, hash: block.block_hash, parentHash: block.parent_hash, timestamp: block.timestamp,
      events: [], sources: [], sourceStarts: {}, observedAt: Date.now() });
  }
  await store.put('status', 'rpc', { head: latest.block_number, hash: latest.block_hash, observedAt: Date.now(), identityVerified: false, error: null });
  return { indexed: (await store.head())?.number ?? null, head: latest.block_number, mode: 'headers_only', sourceCoverageClaimed: false };
}
