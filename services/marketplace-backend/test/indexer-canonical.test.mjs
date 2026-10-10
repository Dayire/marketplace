import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { scanOnce } from '../src/indexer.mjs';
import { enqueueBackfill, runBackfill } from '../src/backfill.mjs';
import { collectionRecord } from '../src/collection-catalog.mjs';
import { SELECTORS } from '../src/decode.mjs';
import { address } from '../src/domain.mjs';
import { selectorFromName } from '../src/starknet-selector.mjs';

const A = address('0xa'), X = address('0xb'), OLD = '0x11', NEW = '0x12';
const hash = n => `0x${(100 + n).toString(16)}`;
const cfg = { chainId: '0x1', marketplace: null, collections: [{ address: A, startBlock: 10 }] };
import { canonicalHarness } from './fixtures/canonical-chain.mjs';
const transfer = { from_address: X, keys: [SELECTORS.Transfer], data: ['0x0', '0x2', '7', '0'] };

test('an older discovered deployment attaches only with a pinned anchor and verified RPC parent', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.applyBlock({ number: 10, hash: hash(10), parentHash: hash(9), timestamp: 110, events: [], sources: [A], sourceStarts: { [A]: 10 } });
  const before = store.get('progress', A);
  const record = collectionRecord({ chainId: cfg.chainId, address: X, standard: 'ERC721', state: 'candidate', deployment: { block: 2, hash: hash(2) },
    classHistory: [{ classHash: OLD, from: { block: 2, hash: hash(2) } }], decoderVersion: 'nft-events.v2', classification: { standard: 'ERC721', method: 'abi', classHash: OLD } });
  store.put('catalog_collection', record.id, record, 2);
  const rpc = canonicalHarness({ events: new Map([[3, [transfer]]]) });
  await enqueueBackfill(store, cfg, { collection: X, target: 10 });
  const result = await runBackfill(store, rpc, cfg, { window: 4 });
  assert.equal(result.promoted, 1, JSON.stringify(result));
  assert.equal(store.get('token', `${X}:7`).owner, address('0x2'));
  assert.deepEqual(store.get('progress', A), before);
  assert.equal(store.head().number, 10);
});

test('historical ABI selection preserves both sides of an ordered class upgrade in one window', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const upgrade = { from_address: X, keys: [selectorFromName('Upgraded')], data: [NEW] };
  const current = { from_address: X, keys: [SELECTORS.Transfer, '0x0', '0x3'], data: ['8', '0'] };
  const rpc = canonicalHarness({ height: 2, events: new Map([[1, [transfer]], [2, [upgrade, current]]]), classes: n => n < 2 ? OLD : NEW });
  await scanOnce(store, rpc, { ...cfg, collections: [{ address: X, startBlock: 1 }] });
  assert.equal(store.get('token', `${X}:7`)?.owner, address('0x2'));
  assert.equal(store.get('token', `${X}:8`)?.owner, address('0x3'));
  const rows = store.db.prepare('SELECT body FROM events ORDER BY block_hash, idx').all().map(row => JSON.parse(row.body));
  assert.equal(rows.length, 3, 'the ABI-proven upgrade remains replayable raw evidence');
  assert.equal(rows.find(row => row.raw.keys[0] === upgrade.keys[0]).type, 'unmodeled');
});

test('a scoped coverage failure preserves healthy global freshness and reports its own source error', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const healthy = { head: 10, hash: hash(10), observedAt: 1000, identityVerified: true, error: null };
  store.applyBlock({ number: 10, hash: hash(10), parentHash: hash(9), timestamp: 110, events: [] });
  store.put('status', 'rpc', healthy);
  const rpc = canonicalHarness({ events: new Map([[10, [transfer]]]) });
  const call = rpc.call;
  rpc.call = (method, params) => method === 'starknet_getEvents' ? { events: [] } : call(method, params);
  await assert.rejects(scanOnce(store, rpc, { ...cfg, collections: [{ address: X, startBlock: 10 }] }, { scope: [X], from: 10, stopAt: 10 }), { code: 'EVENT_COVERAGE' });
  assert.deepEqual(store.get('status', 'rpc'), healthy);
  assert.equal(store.get('status', `source:${X}`).error, 'EVENT_COVERAGE');
});
