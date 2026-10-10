import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { testDatabase } from "./helpers.mjs";
import { migrate } from "../../src/postgres/migrate.mjs";
import { PgStore } from "../../src/postgres/store.mjs";
import { PgDiscoveryCatalog } from "../../src/postgres/discovery-catalog.mjs";
import { initializeRegistry } from "../../src/postgres/import-sqlite.mjs";
import { createApi } from "../../src/api.mjs";
import { address } from "../../src/domain.mjs";
import { collectionKey } from "../../src/collection-catalog.mjs";

const config = {
  chain: "LOCAL",
  chainId: "0x1",
  marketplace: address("99"),
  marketplaceStartBlock: 1,
  collections: [{ address: address("9"), startBlock: 1, name: "Realms" }],
  currencies: [],
  operatorToken: "a".repeat(32),
  origin: "https://market.example",
};
async function fixture(t) {
  const db = await testDatabase(t),
    pool = db.pool();
  await migrate(pool);
  await initializeRegistry(pool, config);
  const store = new PgStore(pool),
    catalog = new PgDiscoveryCatalog(store, config);
  return { db, pool, store, catalog };
}
const block = (number) => ({
  number,
  hash: `0x${number}`,
  parentHash: `0x${number - 1}`,
  timestamp: number,
  sources: [address("9"), address("99")],
  sourceStarts: { [address("9")]: 1, [address("99")]: 1 },
  events: [],
});

test("catalog migration preserves existing collections, metadata, application/media records and trading policy", async (t) => {
  const db = await testDatabase(t),
    pool = db.pool();
  await pool.query(
    "CREATE TABLE public.marketplace_migrations(version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const [version, name] of [
    [1, "001-initial.sql"],
    [2, "002-history-ranges.sql"],
    [3, "003-image-sources.sql"],
  ]) {
    const sql = readFileSync(
      new URL(`../../src/postgres/${name}`, import.meta.url),
      "utf8",
    );
    await pool.query(sql);
    await pool.query(
      "INSERT INTO public.marketplace_migrations(version,checksum) VALUES($1,$2)",
      [version, createHash("sha256").update(sql).digest("hex")],
    );
  }
  const store = new PgStore(pool);
  await store.bindIdentity({
    chainId: config.chainId,
    marketplace: config.marketplace,
  });
  await store.put("collection", address("9"), config.collections[0]);
  await store.put("policy", "collection:" + address("9"), { enabled: true });
  await store.putMetadata("token", { metadata: { name: "Keep me" } });
  await pool.query("INSERT INTO app.sessions VALUES('session',$1,4000000000)", [
    address("2"),
  ]);
  await pool.query("INSERT INTO app.app_meta VALUES($1,$2)", [
    `verification:${address("9")}`,
    { verified: true },
  ]);
  await pool.query("INSERT INTO media.assets VALUES($1,'image/png',$2)", [
    "a".repeat(64) + ".png",
    Buffer.from("durable bytes"),
  ]);
  await store.applyBlock(block(1));
  await store.put("progress", address("12"), {
    source: address("12"),
    block: 1,
  });
  const tables = [
    "market.collections",
    "market.policies",
    "market.token_metadata",
    "app.sessions",
    "app.app_meta",
    "media.assets",
    "chain.progress",
    "chain.blocks",
  ];
  const before = await Promise.all(
    tables.map(
      async (table) => (await pool.query(`SELECT * FROM ${table}`)).rows,
    ),
  );
  await migrate(pool);
  await migrate(pool);
  const after = await Promise.all(
    tables.map(
      async (table) => (await pool.query(`SELECT * FROM ${table}`)).rows,
    ),
  );
  assert.deepEqual(after, before);
  const catalog = new PgDiscoveryCatalog(store, config);
  const existing = await catalog.collection("9");
  assert.equal(existing.address, address("9"));
  assert.equal(existing.visible, true);
  assert.equal(existing.verified, true);
  assert.equal(existing.tradable, true);
  assert.equal(existing.state, "syncing");
  assert.equal(existing.coverage.startBlock, 1);
  assert.equal(existing.coverage.hash, "0x1");
  const incomplete = await catalog.coverage("12");
  assert.equal(incomplete.block, null);
  assert.equal(incomplete.hash, null);
  assert.equal(incomplete.startBlock, null);
});

test("discovery stores evidence and coverage atomically without conferring visibility, verification or trading", async (t) => {
  const { catalog, store, pool } = await fixture(t);
  await store.applyBlock(block(1));
  await catalog.commit(
    {
      address: "10",
      state: "indexed",
      standard: "ERC721",
      deployment: { block: 1, hash: "0x1" },
      decoderVersion: "erc721-v1",
    },
    { startBlock: 1, block: 1, hash: "0x1", observedAt: Date.now() },
    1,
  );
  const discovered = await catalog.collection("10");
  assert.equal(discovered.state, "indexed");
  assert.equal(discovered.visible, false);
  assert.equal(discovered.verified, false);
  assert.equal(discovered.tradable, false);
  assert.equal((await store.list("collection")).length, 1);
  assert.equal((await store.list("policy")).length, 0);
  await assert.rejects(
    pool.query(
      "UPDATE chain.collection_catalog SET body=body || '{\"verified\":true}'::jsonb",
    ),
    (e) => e.code === "23514",
  );
  await assert.rejects(
    pool.query("UPDATE chain.source_coverage SET body=body - 'gaps'"),
    (e) => e.code === "23514",
  );
  await catalog.commit({ address: "10", state: "syncing" }, null, 1);
  assert.equal((await catalog.collection("10")).deployment.block, 1);
  assert.equal((await catalog.collection("10")).decoderVersion, "erc721-v1");
  await assert.rejects(
    catalog.commit(
      { address: "10", deployment: { block: 1, hash: "0xf" } },
      null,
      1,
    ),
    /canonical/i,
  );
  assert.equal((await catalog.collection("10")).deployment.hash, "0x1");
  await assert.rejects(
    new PgDiscoveryCatalog(store, { ...config, chainId: "0x2" }).commit(
      { address: "10" },
      null,
      1,
    ),
    /chain/i,
  );
  await assert.rejects(
    catalog.commit(
      { address: "11", state: "candidate" },
      { startBlock: 1, block: 1, hash: "0xdead", observedAt: Date.now() },
      1,
    ),
    /canonical/i,
  );
  assert.equal(
    (
      await pool.query("SELECT id FROM chain.collection_catalog WHERE id=$1", [
        collectionKey("1", "11"),
      ])
    ).rowCount,
    0,
  );
  await assert.rejects(
    catalog.commit({ address: "10", verified: true }, null, 1),
    /policy/i,
  );
  await assert.rejects(
    catalog.commit({ address: "10", standard: "ERC721" }, null, 0),
    /canonical/i,
  );
});

test("catalog provenance and explicit coverage rewind together; durable policy survives", async (t) => {
  const { catalog, store, pool } = await fixture(t);
  await store.applyBlock(block(1));
  await catalog.commit(
    {
      address: "10",
      state: "candidate",
      deployment: { block: 1, hash: "0x1" },
    },
    { startBlock: 1, block: 1, hash: "0x1", observedAt: Date.now() },
    1,
  );
  await pool.query("INSERT INTO app.app_meta VALUES($1,$2)", [
    `catalog_visibility:${collectionKey("1", "10")}`,
    { visible: true },
  ]);
  await store.applyBlock(block(2));
  await catalog.commit(
    {
      ...(await store.get("catalog_collection", collectionKey("1", "10"))),
      state: "indexed",
      decoderVersion: "erc721-v2",
    },
    { startBlock: 1, block: 2, hash: "0x2", observedAt: Date.now() },
    2,
  );
  await store.rewind(1);
  const restored = await catalog.collection("10");
  assert.equal(restored.state, "candidate");
  assert.equal(restored.decoderVersion, null);
  assert.equal(restored.coverage.block, 1);
  assert.equal(restored.visible, true);
  assert.equal(restored.tradable, false);
  assert.equal(
    (await catalog.readiness([{ address: "10", requiredStartBlock: 1 }])).ready,
    false,
  );
});

test("source-scoped readiness follows legacy progress, preserves gaps and excludes unrelated failures", async (t) => {
  const { catalog, store } = await fixture(t);
  await store.applyBlock(block(1));
  await store.applyBlock(block(2));
  await store.put("status", "rpc", {
    head: 2,
    observedAt: Date.now(),
    identityVerified: true,
  });
  await catalog.commit(
    { address: "10", state: "failed" },
    {
      startBlock: null,
      block: 2,
      hash: "0x2",
      gaps: [{ from: 0, to: 1, reason: "RPC unavailable" }],
      observedAt: Date.now(),
    },
    2,
  );
  assert.equal(
    (await catalog.readiness([{ address: "9", requiredStartBlock: 1 }])).ready,
    true,
  );
  const incomplete = await catalog.readiness([
    { address: "10", requiredStartBlock: 0 },
  ]);
  assert.equal(incomplete.ready, false);
  assert.ok(incomplete.reasons.includes("HISTORY_GAP"));
  assert.ok(incomplete.reasons.includes("SOURCE_FAILED"));
  await store.put("status", "history", { state: "pending", cutoff: 1 });
  assert.ok(
    (
      await catalog.readiness([{ address: "9", requiredStartBlock: 1 }])
    ).reasons.includes("HISTORY_RECONCILIATION_REQUIRED"),
  );
});

test("explicit coverage requires the catalog projection to share its replay generation", async (t) => {
  const { catalog, store } = await fixture(t);
  await store.applyBlock(block(1));
  await store.put("status", "rpc", {
    head: 1,
    observedAt: Date.now(),
    identityVerified: true,
  });
  const record = await catalog.commit(
    { address: "10", state: "indexed", standard: "ERC721" },
    { startBlock: 1, block: 1, hash: "0x1", observedAt: Date.now() },
    1,
  );
  const scope = [{ address: "10", requiredStartBlock: 1 }];
  assert.equal((await catalog.readiness(scope)).ready, true);
  await store.put("catalog_collection", record.id, {
    ...record,
    replayGeneration: 2,
  });
  const mismatched = await catalog.readiness(scope);
  assert.equal(mismatched.ready, false);
  assert.ok(mismatched.reasons.includes("GENERATION_MISMATCH"));
});

test("authenticated catalog API is bounded, exposes independent states and keeps public collection scope", async (t) => {
  const { catalog, store } = await fixture(t);
  await store.applyBlock(block(1));
  await catalog.commit(
    {
      address: "10",
      state: "unsupported",
      classification: { reason: "custom events" },
    },
    null,
    1,
  );
  const server = createApi({ store, config });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/v1/chains/LOCAL`;
  const headers = { authorization: "Bearer " + config.operatorToken };
  assert.equal((await fetch(base + "/operator/catalog")).status, 403);
  const first = await (
    await fetch(base + "/operator/catalog?limit=1", { headers })
  ).json();
  assert.equal(first.data.items.length, 1);
  assert.ok(first.data.nextCursor);
  const second = await (
    await fetch(
      base + "/operator/catalog?limit=1&cursor=" + first.data.nextCursor,
      { headers },
    )
  ).json();
  assert.equal(second.data.items[0].state, "unsupported");
  assert.equal(second.data.items[0].tradable, false);
  assert.equal(
    (await fetch(base + "/operator/catalog?limit=101", { headers })).status,
    400,
  );
  for (const value of [null, [], {}])
    assert.equal(
      (
        await fetch(
          base +
            "/operator/catalog?cursor=" +
            Buffer.from(JSON.stringify(value)).toString("base64url"),
          { headers },
        )
      ).status,
      400,
    );
  const publicResult = await (await fetch(base + "/collections")).json();
  assert.equal(publicResult.data.length, 1);
  const detail = await (
    await fetch(base + "/operator/catalog/10", { headers })
  ).json();
  assert.equal(detail.data.classification.reason, "custom events");
  assert.equal(detail.data.readiness.ready, false);
  assert.ok(detail.data.readiness.reasons.includes("SOURCE_UNSUPPORTED"));
  await store.rewind(0);
  assert.equal(
    (
      await fetch(base + "/operator/catalog?cursor=" + first.data.nextCursor, {
        headers,
      })
    ).status,
    400,
  );
});
