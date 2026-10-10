import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PgStore } from '../../src/postgres/store.mjs';
import { migrate } from '../../src/postgres/migrate.mjs';
import { runIndexingCycle } from '../../src/source-cycle.mjs';
import { enqueueBackfill, runBackfill } from '../../src/backfill.mjs';
import { address } from '../../src/domain.mjs';
import { SELECTORS } from '../../src/decode.mjs';
import { collectionKey, collectionRecord } from '../../src/collection-catalog.mjs';
import { canonicalHarness } from '../fixtures/canonical-chain.mjs';
import { cfg, opts, sourceHarness } from '../fixtures/source-chain.mjs';
import { testDatabase } from './helpers.mjs';

const A = address('0xa'), X = address('0xb'), hash = n => `0x${(100 + n).toString(16)}`;

test('PostgreSQL dynamic backfill reaches promotion without changing live progress or durable visibility', async t => {
  const db = await testDatabase(t), pool = db.pool(); await migrate(pool);
  let store = new PgStore(pool); const rpc = sourceHarness();
  await store.query('INSERT INTO app.moderation VALUES($1,$2)', [X, { hidden: true, verified: false }]);
  for (let i = 0; i < 8; i++) await runIndexingCycle(store, rpc, cfg, opts);
  assert.equal((await store.get('catalog_collection', collectionKey(cfg.chainId, X))).state, 'indexed');
  assert.equal((await store.get('progress', A)).block, 6);
  assert.equal((await store.get('token', `${X}:7`)).owner, address('0x2'));
  const before = (await store.query('SELECT body FROM app.moderation WHERE collection=$1', [X])).rows[0].body;
  store = new PgStore(pool); rpc.setHead(7);
  await runIndexingCycle(store, rpc, cfg, opts);
  assert.equal((await store.get('progress', X)).block, 7);
  assert.equal((await store.list('backfill_job')).length, 1);
  assert.deepEqual((await store.query('SELECT body FROM app.moderation WHERE collection=$1', [X])).rows[0].body, before);
});

test('PostgreSQL attaches an older deployment with scanner-verified ancestry and preserves the live head', async t => {
  const db = await testDatabase(t), pool = db.pool(); await migrate(pool);
  const store = new PgStore(pool);
  await store.bindIdentity({ chainId: cfg.chainId, marketplace: null });
  await store.applyBlock({ number: 10, hash: hash(10), parentHash: hash(9), timestamp: 110, events: [], sources: [A], sourceStarts: { [A]: 10 } });
  const record = collectionRecord({ chainId: cfg.chainId, address: X, standard: 'ERC721', state: 'candidate', deployment: { block: 2, hash: hash(2) },
    classHistory: [{ classHash: '0x11', from: { block: 2, hash: hash(2) } }], decoderVersion: 'nft-events.v2', classification: { standard: 'ERC721', method: 'abi', classHash: '0x11' } });
  await store.put('catalog_collection', record.id, record, 2);
  const events = new Map([[3, [{ from_address: X, keys: [SELECTORS.Transfer], data: ['0x0', '0x2', '7', '0'] }]]]);
  const rpc = canonicalHarness({ height: 10, events });
  const local = { ...cfg, collections: [{ address: A, startBlock: 10 }] };
  await enqueueBackfill(store, local, { collection: X, target: 10 });
  assert.equal((await runBackfill(store, rpc, local, { window: 4 })).promoted, 1);
  assert.equal((await store.head()).number, 10);
  assert.equal((await store.get('progress', A)).startBlock, 10);
  assert.equal((await store.get('token', `${X}:7`)).owner, address('0x2'));
});

test('the supervised PostgreSQL catalog worker owns one lease and automatically promotes without another discovery process', async t => {
  let child, rpc;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    if (rpc) { rpc.closeAllConnections(); await new Promise(resolve => rpc.close(resolve)); }
  });
  const db = await testDatabase(t), pool = db.pool(); await migrate(pool);
  const store = new PgStore(pool); await store.bindIdentity({ chainId: cfg.chainId, marketplace: null });
  const harness = sourceHarness();
  rpc = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const query = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: query.id, result: await harness.call(query.method, query.params) }));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve));
  child = spawn(process.execPath, ['services/marketplace-backend/src/worker.mjs', 'index'], { env: { ...process.env, DATABASE_URL: db.url,
    MARKETPLACE_STORE: 'postgres', MARKETPLACE_CHAIN: 'LOCAL', MARKETPLACE_REGISTRY_JSON: JSON.stringify({ chains: { LOCAL: cfg } }),
    MARKETPLACE_CATALOG_ENABLED: 'true', MARKETPLACE_BACKGROUND_ENABLED: 'true', MARKETPLACE_INDEX_WINDOW: '16', MARKETPLACE_CATALOG_BACKFILL_WINDOW: '16',
    MARKETPLACE_RPC_URL: `http://127.0.0.1:${rpc.address().port}`, PORT: '', MARKETPLACE_WORKER_PORT: '',
  } });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(stderr);
    if ((await store.get('catalog_collection', collectionKey(cfg.chainId, X)))?.state === 'indexed') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal((await store.list('backfill_job'))[0]?.state, 'promoted', stderr);
  await assert.rejects(new PgStore(pool).acquireIndexerLease(), { code: 'INDEXER_LEASE_HELD' });
});
