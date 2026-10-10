import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './helpers.mjs';
import { migrate, SCHEMA_VERSION } from '../../src/postgres/migrate.mjs';
import { PgStore } from '../../src/postgres/store.mjs';
import { runtime } from '../../src/runtime.mjs';

test('PostgreSQL startup requires every additive migration through the balance invariant version', async t => {
  const db = await testDatabase(t), pool = db.pool();
  await migrate(pool);
  const store = new PgStore(pool);
  await store.bindIdentity({ chainId: '0x1', marketplace: null });
  const env = { DATABASE_URL: db.url, MARKETPLACE_STORE: 'postgres', MARKETPLACE_CHAIN: 'LOCAL',
    MARKETPLACE_REGISTRY_JSON: JSON.stringify({ chains: { LOCAL: { chainId: '0x1', marketplace: null, collections: [], currencies: [] } } }) };
  const valid = await runtime(env); await valid.store.close();
  await pool.query('DELETE FROM public.marketplace_migrations WHERE version=$1', [SCHEMA_VERSION]);
  await assert.rejects(async () => { const unexpected = await runtime(env); await unexpected.store.close(); }, new RegExp(`migration ${SCHEMA_VERSION} is required`));
  assert.equal((await pool.query('SELECT count(*) AS n FROM public.marketplace_migrations')).rows[0].n, String(SCHEMA_VERSION - 1), 'startup never performs migrations');
});
