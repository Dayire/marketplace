import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { testDatabase } from './helpers.mjs';
import { migrate, SCHEMA_VERSION } from '../../src/postgres/migrate.mjs';

test('an already-applied upstream image migration upgrades without checksum drift or data loss', async t => {
  const db = await testDatabase(t), pool = db.pool();
  const assetName = 'a'.repeat(64) + '.png';
  await pool.query('CREATE TABLE public.marketplace_migrations(version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const original = new Map();
  for (const [version, name] of [[1, '001-initial.sql'], [2, '002-history-ranges.sql'], [3, '003-image-sources.sql'], [4, '004-image-source-hashes.sql']]) {
    const sql = readFileSync(new URL(`../../src/postgres/${name}`, import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    await pool.query(sql);
    await pool.query('INSERT INTO public.marketplace_migrations(version,checksum) VALUES($1,$2)', [version, checksum]);
    original.set(version, checksum);
  }
  await pool.query("INSERT INTO app.app_meta(key,value) VALUES('operator-choice','{\"visible\":false}'::jsonb)");
  await pool.query("INSERT INTO media.assets(name,content_type,bytes) VALUES($1,'image/png',decode('010203','hex'))", [assetName]);
  await migrate(pool);
  await migrate(pool);
  const versions = (await pool.query('SELECT version,checksum FROM public.marketplace_migrations ORDER BY version')).rows;
  assert.equal(versions.length, SCHEMA_VERSION);
  for (const row of versions.filter(v => v.version <= 4)) assert.equal(row.checksum, original.get(row.version));
  assert.deepEqual((await pool.query("SELECT value FROM app.app_meta WHERE key='operator-choice'")).rows[0].value, { visible: false });
  assert.equal((await pool.query("SELECT encode(bytes,'hex') AS value FROM media.assets WHERE name=$1", [assetName])).rows[0].value, '010203');
  assert.ok((await pool.query("SELECT to_regclass('chain.collection_catalog') AS name")).rows[0].name);
  assert.ok((await pool.query("SELECT to_regclass('market.token_metadata_image_source_hash') AS name")).rows[0].name);
});
