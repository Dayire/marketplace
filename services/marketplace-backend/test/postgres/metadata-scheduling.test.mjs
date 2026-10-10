import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { testDatabase } from "./helpers.mjs";
import { migrate } from "../../src/postgres/migrate.mjs";
import { PgStore } from "../../src/postgres/store.mjs";
import { provisionRoles } from "../../src/postgres/roles.mjs";
import { metadataCandidates, expandMetadataJobs, claimMetadataJob, completeMetadataJob, metadataAuthorityVersion } from "../../src/metadata-store.mjs";
import { address } from "../../src/domain.mjs";
import { collectionRecord } from "../../src/collection-catalog.mjs";

const A = address("0xa1"), B = address("0xb1");
const token = (collection, i) => ({ id: `${collection}:${i}`, collection, tokenId: String(i), owner: address("2"),
  updatedAt: { blockHash: "0xabc", transactionHash: "0x1", eventIndex: 0 } });
async function fixture(t) {
  const db = await testDatabase(t), pool = db.pool();
  await migrate(pool);
  return { store: new PgStore(pool), pool };
}

test("PostgreSQL metadata quota cannot starve another collection, and range expansion preserves leases and rotates", async (t) => {
  const { store } = await fixture(t);
  for (let i = 0; i < 250; i++) await store.put("token", `${A}:${i}`, token(A, i));
  for (let i = 0; i < 6; i++) await store.put("token", `${B}:${i}`, token(B, i));
  const picked = await metadataCandidates(store, 1000, 6, 3);
  assert.equal(picked.length, 6);
  assert.deepEqual([A, B].map((a) => picked.filter((item) => item.collection === a).length), [3, 3]);
  for (const collection of [A, B]) await store.put("metadata_job", `${collection}:*`, { collection, state: "pending" });
  await store.put("metadata_job", `${A}:0`, { state: "running", lease: "existing-worker", leaseUntil: Date.now() + 60000 });
  await expandMetadataJobs(store);
  assert.equal((await store.get("metadata_job", `${A}:0`)).lease, "existing-worker");
  await expandMetadataJobs(store);
  assert.equal((await store.get("metadata_job", `${B}:*`)).state, "complete");
  assert.equal((await store.get("metadata_job", `${A}:*`)).state, "pending");
});

test("PostgreSQL same-block metadata completion cannot apply an older event's result", async (t) => {
  const { store } = await fixture(t), original = token(A, 0);
  await store.put("token", original.id, original);
  const claim = await claimMetadataJob(store, original, 1000);
  await store.put("token", original.id, { ...original, owner: address("3"),
    updatedAt: { ...original.updatedAt, transactionHash: "0x2", eventIndex: 1 } });
  assert.equal(await completeMetadataJob(store, original, claim, { metadataStatus: "ready", metadata: { name: "stale" } }), false);
  const current = await store.get("token", original.id);
  assert.equal(current.owner, address("3"));
  assert.equal(current.metadata?.name, undefined);
});

test("PostgreSQL ERC1155 metadata deduplicates many owners and retains retry backoff without an ERC721 owner projection", async (t) => {
  const { store } = await fixture(t);
  for (const owner of [address("2"), address("3")])
    for (let i = 0; i < 120; i++) await store.put("erc1155_balance", `${A}:${i}:${owner}`, {
      collection: A, tokenId: String(i), owner, balance: "7", balanceFelts: ["0x7", "0x0"],
      updatedAt: token(A, i).updatedAt,
    });
  for (let i = 0; i < 3; i++) await store.put("token", `${B}:${i}`, token(B, i));
  const picked = await metadataCandidates(store, 1000, 6, 3);
  assert.equal(picked.length, 6);
  const multi = picked.filter((item) => item.collection === A);
  assert.equal(multi.length, 3);
  assert.equal(new Set(multi.map((item) => item.id)).size, 3);
  const item = multi[0], claim = await claimMetadataJob(store, item, 1000);
  assert.equal(await completeMetadataJob(store, item, claim, { metadataStatus: "ready", metadata: { name: "Multi token" }, metadataNextAttempt: 5000 }), true);
  assert.equal(await store.get("token", item.id), null);
  assert.equal((await store.query("SELECT body FROM market.token_metadata WHERE id=$1", [item.id])).rows[0].body.metadata.name, "Multi token");
  assert.ok(!(await metadataCandidates(store, 1000, 100, 50)).some((entry) => entry.id === item.id));
});

test("PostgreSQL metadata completion rejects class evidence changed during fetching even without an owner event", async (t) => {
  const { store } = await fixture(t), original = token(A, 0);
  await store.put("token", original.id, original);
  const record = collectionRecord({ chainId: "0x1", address: A, standard: "ERC721", state: "indexed",
    classification: { standard: "ERC721", classHash: "0x123", method: "abi" } });
  await store.put("catalog_collection", record.id, record);
  const claim = await claimMetadataJob(store, original, 1000);
  claim.sourceAuthority = metadataAuthorityVersion(record);
  await store.put("catalog_collection", record.id, { ...record, standard: "ERC1155", state: "unknown",
    classification: { ...record.classification, classHash: "0x456" } });
  assert.equal(await completeMetadataJob(store, original, claim, { metadataStatus: "ready", metadata: { name: "Old URI" } }), false);
  assert.equal((await store.get("token", original.id)).metadata?.name, undefined);
});

test("metadata role can read proven discovery/balances but cannot change chain evidence or balances", async (t) => {
  const { store, pool } = await fixture(t);
  const record = collectionRecord({ chainId: "0x1", address: A, standard: "ERC1155" });
  await store.put("catalog_collection", record.id, record);
  const prefix = "m" + randomUUID().replaceAll("-", "").slice(0, 15), roles = Object.fromEntries(
    ["api", "index", "metadata"].map((kind) => [kind, { name: `${prefix}_${kind}`, password: randomBytes(32).toString("hex") }]));
  await provisionRoles(pool, roles);
  const installedVersion = (await pool.query("SELECT max(version)::int AS version FROM public.marketplace_migrations")).rows[0].version;
  const client = await pool.connect();
  try {
    for (const role of Object.values(roles)) {
      await client.query(`SET ROLE "${role.name}"`);
      assert.equal((await client.query("SELECT max(version)::int AS version FROM public.marketplace_migrations")).rows[0].version, installedVersion);
      await assert.rejects(client.query("UPDATE public.marketplace_migrations SET version=version"), (e) => e.code === "42501");
      await client.query("RESET ROLE");
    }
    await client.query(`SET ROLE "${roles.metadata.name}"`);
    assert.equal((await client.query("SELECT body FROM chain.collection_catalog")).rows[0].body.standard, "ERC1155");
    await client.query("SELECT body FROM chain.class_evidence");
    assert.deepEqual(await metadataCandidates({ dialect: "postgres", query: client.query.bind(client) }, 1000, 4, 2), []);
    await assert.rejects(client.query("UPDATE chain.collection_catalog SET body=body"), (e) => e.code === "42501");
    await assert.rejects(client.query("UPDATE market.erc1155_balances SET body=body"), (e) => e.code === "42501");
    await assert.rejects(client.query("SELECT * FROM app.sessions"), (e) => e.code === "42501");
  } finally {
    await client.query("RESET ROLE"); client.release();
    for (const role of Object.values(roles)) { await pool.query(`DROP OWNED BY "${role.name}"`); await pool.query(`DROP ROLE "${role.name}"`); }
  }
});
