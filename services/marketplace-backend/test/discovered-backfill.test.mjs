import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { enqueueBackfill, runBackfill } from '../src/backfill.mjs';
import { scanOnce } from '../src/indexer.mjs';
import { collectionKey, collectionRecord } from '../src/collection-catalog.mjs';
import { SELECTORS } from '../src/decode.mjs';
import { address } from '../src/domain.mjs';

const A = address('0xa'), X = address('0xb');
const config = { chainId: '0x1', marketplace: null, collections: [{ address: A, startBlock: 0 }] };
const hash = n => `0x${(100 + n).toString(16)}`;
const raw = { from_address: X, keys: [SELECTORS.Transfer], data: ['0x0', '0x2', '7', '0'] };
function rpcHarness() {
  let height = 6;
  return {
    setHead: n => { height = n; },
    call: async (method, p) => {
      if (method === 'starknet_chainId') return config.chainId;
      if (method === 'starknet_getClassHashAt') return '0xdef';
      if (method === 'starknet_call') return ['0x2'];
      if (method === 'starknet_getClass') return { abi: [{ type: 'event', name: 'Transfer', keys: [], data: [
        { name: 'from', type: 'felt' }, { name: 'to', type: 'felt' }, { name: 'token_id', type: 'Uint256' },
      ] }, { type: 'function', name: 'ownerOf', inputs: [{ name: 'tokenId', type: 'Uint256' }], outputs: [{ name: 'owner', type: 'felt' }] }] };
      if (method === 'starknet_getEvents') return { events: p.filter.from_block.block_number <= 3 && p.filter.to_block.block_number >= 3
        ? [{ ...raw, block_number: 3, block_hash: hash(3), transaction_hash: '0xbb' }] : [] };
      const n = p.block_id === 'latest' ? height : p.block_id.block_number ?? Number(BigInt(p.block_id.block_hash)) - 100;
      return { block_number: n, block_hash: hash(n), parent_hash: n ? hash(n - 1) : '0x0', timestamp: n + 100,
        status: 'ACCEPTED_ON_L2', transactions: method === 'starknet_getBlockWithReceipts' && n === 3
          ? [{ receipt: { transaction_hash: '0xbb', execution_status: 'SUCCEEDED', events: [raw] } }] : [] };
    },
  };
}
function seed(store, value = {}) {
  const record = collectionRecord({ chainId: config.chainId, address: X, standard: 'ERC721', state: 'candidate',
    deployment: { block: 2, hash: hash(2) }, classHistory: [{ classHash: '0xdef', from: { block: 2, hash: hash(2) } }],
    decoderVersion: 'nft-events.v2', classification: { standard: 'ERC721', method: 'src5', classHash: '0xdef', uncertainty: null }, ...value });
  store.put('catalog_collection', record.id, record, 2);
  return record;
}

test('a classified collection backfills without editing the configured registry or rebuilding live sources', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const rpc = rpcHarness(); await scanOnce(store, rpc, config); seed(store);
  const before = store.get('progress', A), identity = store.head();
  store.app.prepare('INSERT INTO moderation(collection,body) VALUES(?,?)').run(X, JSON.stringify({ hidden: true, verified: false }));
  const job = await enqueueBackfill(store, config, { collection: X, target: 6 });
  assert.equal(job.from, 2);
  const result = await runBackfill(store, rpc, config, { window: 2 });
  assert.equal(result.promoted, 1, JSON.stringify(result));
  assert.equal(store.get('token', `${X}:7`).owner, address('0x2'));
  assert.deepEqual(store.get('progress', A), before);
  assert.deepEqual(store.head(), identity);
  assert.equal(config.collections.length, 1);
  assert.equal(JSON.parse(store.app.prepare('SELECT body FROM moderation WHERE collection=?').get(X).body).hidden, true);
});

test('a pinned ownership mismatch prevents promotion while preserving the replayable projection', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const rpc = rpcHarness(); await scanOnce(store, rpc, config); seed(store);
  const call = rpc.call;
  rpc.call = (method, params) => method === 'starknet_call' ? ['0x3'] : call(method, params);
  await enqueueBackfill(store, config, { collection: X, target: 6 });
  const result = await runBackfill(store, rpc, config, { window: 2 });
  assert.equal(result.promoted, 0);
  assert.equal(result.failed, 1);
  assert.equal(store.get('status', `reconciliation:${X}`).state, 'mismatch');
  assert.equal(store.get('token', `${X}:7`).owner, address('0x2'));
  assert.equal(store.list('backfill_job')[0].cursor, 6, 'failed reconciliation retains the committed cursor');
});

test('a restart resumes from a committed source checkpoint if the workflow cursor write was interrupted', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const rpc = rpcHarness(); await scanOnce(store, rpc, config); seed(store);
  const job = await enqueueBackfill(store, config, { collection: X, target: 6 });
  await runBackfill(store, rpc, config, { window: 1, maxRounds: 1, yieldAfterRound: true });
  store.put('backfill_job', job.id, { ...store.get('backfill_job', job.id), cursor: 1 });
  const resumed = await runBackfill(store, rpc, config, { window: 1, maxRounds: 1, yieldAfterRound: true });
  assert.equal(resumed.jobs[0].cursor, 3);
  assert.equal(store.get('progress', X).block, 3);
});

test('a bounded backfill yields with a durable cursor while existing collections keep advancing', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const rpc = rpcHarness(); await scanOnce(store, rpc, config); seed(store);
  await enqueueBackfill(store, config, { collection: X, target: 6 });
  const result = await runBackfill(store, rpc, config, { window: 1, maxRounds: 1, yieldAfterRound: true });
  assert.equal(result.failed, 0);
  assert.equal(result.jobs[0].state, 'running');
  assert.equal(result.jobs[0].cursor, 2);
  rpc.setHead(7); await scanOnce(store, rpc, config);
  assert.equal(store.get('progress', A).block, 7);
  const resumed = await runBackfill(store, rpc, config, { window: 3 });
  assert.equal(resumed.promoted, 1, JSON.stringify(resumed));
  assert.equal(store.get('progress', X).block, 7);
});

test('unclassified or uncertain proxy candidates cannot be automatically backfilled', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const rpc = rpcHarness(); await scanOnce(store, rpc, config);
  seed(store, { standard: null, classification: null });
  await assert.rejects(enqueueBackfill(store, config, { collection: X, target: 6 }), e => e.code === 'BACKFILL_REGISTRY');
  seed(store, { classification: { method: 'abi', classHash: '0xdef', uncertainty: 'proxy_unverified' } });
  await assert.rejects(enqueueBackfill(store, config, { collection: X, target: 6 }), e => e.code === 'BACKFILL_REGISTRY');
});

test('raw quarantined history remains available but cannot receive an indexed promotion', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const rpc = rpcHarness(); await scanOnce(store, rpc, config); seed(store);
  const call = rpc.call;
  rpc.call = async (method, params) => method === 'starknet_getClass'
    ? { abi: [{ type: 'event', name: 'Transfer', keys: [], data: [{ name: 'amount', type: 'Uint256' }] }] }
    : call(method, params);
  await enqueueBackfill(store, config, { collection: X, target: 6 });
  const result = await runBackfill(store, rpc, config, { window: 2 });
  assert.equal(result.promoted, 0);
  assert.equal(result.failed, 1);
  assert.equal(store.get('catalog_collection', collectionKey(config.chainId, X)).state, 'failed');
  assert.equal(store.get('token', `${X}:7`), null);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE json_extract(body,'$.type')='undecodable'").get().n, 1);
});
