import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { address } from '../src/domain.mjs';
import { collectionKey } from '../src/collection-catalog.mjs';
import { runIndexingCycle } from '../src/source-cycle.mjs';
import { cfg, opts, sourceHarness } from './fixtures/source-chain.mjs';
const A = address('0xa'), X = address('0xb');

test('one bounded writer cycle discovers, queues and promotes a source while the configured source advances', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const rpc = sourceHarness();
  for (let i = 0; i < 8; i++) await runIndexingCycle(store, rpc, cfg, opts);
  assert.equal(store.get('progress', A).block, 6);
  assert.equal(store.get('catalog_collection', collectionKey(cfg.chainId, X)).state, 'indexed');
  assert.equal(store.get('progress', X).block, 6);
  assert.equal(store.get('token', `${X}:7`).owner, address('0x2'));
  assert.equal(store.list('backfill_job').length, 1, 'repeated cycles never duplicate the job');
  assert.equal(store.list('backfill_job')[0].state, 'promoted');
  rpc.setHead(7);
  await runIndexingCycle(store, rpc, cfg, opts);
  assert.equal(store.get('progress', A).block, 7);
  assert.equal(store.get('progress', X).block, 7, 'promoted discovery joins the shared live scan');
  assert.equal(cfg.collections.length, 1, 'settlement configuration is never expanded');
});

test('an enrichment outage stays local while the live source continues', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const rpc = sourceHarness(), call = rpc.call;
  rpc.call = (method, params) => {
    if (method === 'starknet_getStateUpdate') throw Object.assign(new Error('state endpoint outage'), { code: 'RPC_UNAVAILABLE' });
    return call(method, params);
  };
  const result = await runIndexingCycle(store, rpc, cfg, opts);
  assert.equal(result.discovery.error, 'RPC_UNAVAILABLE');
  assert.equal(store.get('progress', A).block, 1);
  assert.equal(store.get('status', 'rpc').error, null);
  rpc.setHead(7); await runIndexingCycle(store, rpc, cfg, opts);
  assert.equal(store.get('progress', A).block, 3);
});

test('an empty settlement registry can bootstrap catalog indexing with explicitly source-free headers', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const rpc = sourceHarness();
  for (let i = 0; i < 5; i++) await runIndexingCycle(store, rpc, { ...cfg, collections: [] }, opts);
  assert.equal(store.get('catalog_collection', collectionKey(cfg.chainId, X)).state, 'indexed');
  assert.equal(store.get('progress', X).block, 6);
  assert.equal(store.get('progress', A), null);
  assert.equal(store.get('token', `${X}:7`).owner, address('0x2'));
});
