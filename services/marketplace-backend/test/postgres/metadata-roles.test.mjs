import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { testDatabase } from "./helpers.mjs";
import { migrate } from "../../src/postgres/migrate.mjs";
import { PgStore } from "../../src/postgres/store.mjs";
import { provisionRoles } from "../../src/postgres/roles.mjs";
import { refreshMetadata } from "../../src/metadata.mjs";
import { address } from "../../src/domain.mjs";
const block = (n, owner) => ({
  number: n,
  hash: "0x" + n,
  parentHash: "0x" + (n - 1),
  timestamp: n,
  events: [
    {
      type: "transfer",
      collection: address("9"),
      tokenId: "1",
      from: address("0"),
      to: address(owner),
    },
  ],
});
const uriFelts = (raw) => {
  const bytes = Buffer.from(
    "data:application/json," + encodeURIComponent(JSON.stringify(raw)),
  );
  const words = [];
  let i = 0;
  for (; i + 31 <= bytes.length; i += 31)
    words.push("0x" + bytes.subarray(i, i + 31).toString("hex"));
  const pending = bytes.subarray(i);
  return [
    String(words.length),
    ...words,
    pending.length ? "0x" + pending.toString("hex") : "0",
    String(pending.length),
  ];
};
test("metadata completion cannot overwrite a transfer that occurred while its RPC request was in flight", async (t) => {
  const db = await testDatabase(t),
    pool = db.pool();
  await migrate(pool);
  const store = new PgStore(pool);
  await store.applyBlock(block(1, "2"));
  let entered;
  const ready = new Promise((r) => (entered = r));
  let release;
  const gate = new Promise((r) => (release = r));
  const rpc = {
    contract: async () => {
      entered();
      await gate;
      return uriFelts({ name: "Realm stale" });
    },
  };
  const work = refreshMetadata(store, rpc, { chain: "LOCAL" }, { limit: 1 });
  await ready;
  await store.applyBlock(block(2, "3"));
  release();
  await work;
  assert.equal(
    (await store.get("token", `${address("9")}:1`)).owner,
    address("3"),
  );
  assert.equal(
    (await store.get("token", `${address("9")}:1`)).metadata.name,
    undefined,
  );
  await assert.rejects(
    store.putMetadata(`${address("9")}:1`, { owner: address("4") }),
    /overwrite/,
  );
});
test("runtime roles isolate application data and chain ownership; metadata and HTTP share immutable media through PostgreSQL", async (t) => {
  const db = await testDatabase(t),
    pool = db.pool();
  await migrate(pool);
  const store = new PgStore(pool);
  await store.applyBlock(block(1, "2"));
  const prefix = "r" + randomUUID().replaceAll("-", "").slice(0, 15);
  const roles = Object.fromEntries(
    ["api", "index", "metadata"].map((kind) => [
      kind,
      { name: prefix + "_" + kind, password: randomBytes(32).toString("hex") },
    ]),
  );
  await provisionRoles(pool, roles);
  // SET ROLE exercises privileges independently of local test-cluster trust authentication.
  for (const kind of ["index", "metadata"]) {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE "${roles[kind].name}"`);
      await assert.rejects(
        client.query("SELECT * FROM app.sessions"),
        (e) => e.code === "42501",
      );
      if (kind === "metadata")
        await assert.rejects(
          client.query("UPDATE market.tokens SET body=body"),
          (e) => e.code === "42501",
        );
    } finally {
      await client.query("RESET ROLE");
      client.release();
    }
  }
  const client = await pool.connect();
  try {
    await client.query(`SET ROLE "${roles.api.name}"`);
    await assert.rejects(
      client.query("DELETE FROM chain.blocks"),
      (e) => e.code === "42501",
    );
  } finally {
    await client.query("RESET ROLE");
    client.release();
  }
  const bytes = Buffer.from("image fixture"),
    name = createHash("sha256").update(bytes).digest("hex") + ".png";
  await store.saveAsset(name, "image/png", bytes);
  assert.deepEqual(await store.asset(name), bytes);
  await assert.rejects(
    store.saveAsset("a".repeat(64) + ".png", "image/png", bytes),
    /Invalid/,
  );
  // Role ownership is cluster-wide; remove grants before dropping these test-only roles.
  for (const spec of Object.values(roles)) {
    await pool.query(`DROP OWNED BY "${spec.name}"`);
    await pool.query(`DROP ROLE "${spec.name}"`);
  }
});

test("metadata reuses unchanged cached images and records failed changed-image downloads", async (t) => {
  const db = await testDatabase(t),
    pool = db.pool();
  await migrate(pool);
  const store = new PgStore(pool);
  await store.applyBlock(block(1, "2"));
  let image =
      "https://example.org/ipfs/QmS136SdgcHsiaKJdFVfQWNMS5tHHcbazbUxYqpUZKVEj6",
    calls = 0,
    fail = false;
  const rpc = { contract: async () => uriFelts({ name: "Realm", image }) };
  const fetchResource = async () => {
    calls++;
    if (fail) throw new Error("Metadata timeout");
    return {
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      contentType: "image/svg+xml",
    };
  };
  const id = `${address("9")}:1`;
  await refreshMetadata(
    store,
    rpc,
    { chain: "LOCAL" },
    { limit: 1, fetchResource },
  );
  const first = await store.get("token", id);
  assert.ok(first.image);
  assert.equal(calls, 1);
  await store.put("metadata_job", id, { state: "pending" });
  fail = true;
  await refreshMetadata(
    store,
    rpc,
    { chain: "LOCAL" },
    { limit: 1, fetchResource },
  );
  const repeat = await store.get("token", id);
  assert.equal(repeat.image, first.image);
  assert.equal(calls, 1, "unchanged media must not download again");
  image = "https://example.org/changed.svg";
  await store.put("metadata_job", id, { state: "pending" });
  await refreshMetadata(
    store,
    rpc,
    { chain: "LOCAL" },
    { limit: 1, fetchResource },
  );
  const failed = await store.get("token", id);
  assert.equal(
    failed.image,
    null,
    "never attribute old artwork to a changed source",
  );
  assert.equal(failed.metadata.imageStatus, "failed");
  assert.equal(failed.metadata.imageError, "Metadata timeout");
  assert.equal(failed.metadataStatus, "ready");
});

test("metadata recovery prioritizes explicit jobs and missing images over cached refreshes", async (t) => {
  const { metadataCandidates } = await import("../../src/metadata-store.mjs");
  const db = await testDatabase(t),
    pool = db.pool();
  await migrate(pool);
  const store = new PgStore(pool);
  const b = block(1, "2");
  b.events = ["1", "2", "3"].map((tokenId) => ({ ...b.events[0], tokenId }));
  await store.applyBlock(b);
  const id = (n) => `${address("9")}:${n}`;
  await store.putMetadata(id(1), {
    image: "/cached.svg",
    metadataFetchedAt: 1,
  });
  await store.putMetadata(id(2), { image: null, metadataFetchedAt: 3 });
  await store.putMetadata(id(3), {
    image: "/cached.svg",
    metadataFetchedAt: 4,
  });
  await store.put("metadata_job", id(3), { state: "pending" });
  assert.deepEqual(
    (await metadataCandidates(store, Date.now(), 3)).map((t) => t.tokenId),
    ["3", "2", "1"],
  );
});

test("metadata downloads overlap within a bounded pool and retain cached mutable media on transient failures", async (t) => {
  const db = await testDatabase(t),
    pool = db.pool();
  await migrate(pool);
  const store = new PgStore(pool);
  const b = block(1, "2");
  b.events = Array.from({ length: 7 }, (_, i) => ({
    ...b.events[0],
    tokenId: String(i + 1),
  }));
  await store.applyBlock(b);
  let active = 0,
    peak = 0;
  const rpc = {
    contract: async () =>
      uriFelts({ name: "Realm", image: "https://example.org/realm.svg" }),
  };
  const fetchResource = async () => {
    active++;
    peak = Math.max(active, peak);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return { bytes: Buffer.from("<svg/>"), contentType: "image/svg+xml" };
  };
  await refreshMetadata(
    store,
    rpc,
    { chain: "LOCAL" },
    { limit: 7, fetchResource },
  );
  assert.ok(peak > 1);
  assert.ok(peak <= 4);
  const id = `${address("9")}:1`,
    first = await store.get("token", id);
  await store.put("metadata_job", id, { state: "pending" });
  await refreshMetadata(
    store,
    rpc,
    { chain: "LOCAL" },
    {
      limit: 1,
      fetchResource: async () => {
        throw new Error("origin unavailable");
      },
    },
  );
  const after = await store.get("token", id);
  assert.equal(after.image, first.image);
  assert.equal(after.metadata.imageError, "origin unavailable");
});

test("immutable image cache is reused for another NFT after a worker restart", async (t) => {
  const db = await testDatabase(t),
    pool = db.pool();
  await migrate(pool);
  const store = new PgStore(pool);
  await store.applyBlock(block(1, "2"));
  const image = "ipfs://QmWqqT4awbuzaHM7e5EBf9GGzNDQRz4WauUDSctVe9ZeBW";
  let downloads = 0;
  const rpc = {
    contract: async () => uriFelts({ name: "Shared chest", image }),
  };
  const fetchResource = async () => {
    downloads++;
    return { contentType: "image/png", bytes: Buffer.from("shared-art") };
  };
  await refreshMetadata(
    store,
    rpc,
    { chain: "LOCAL", collections: [] },
    { limit: 1, fetchResource },
  );
  const first = await store.get("token", address("9") + ":1");
  assert.ok(first.image);
  await store.applyBlock({
    ...block(2, "2"),
    events: [{ ...block(2, "2").events[0], tokenId: "2" }],
  });
  const restartedStore = new PgStore(pool);
  await refreshMetadata(
    restartedStore,
    rpc,
    { chain: "LOCAL", collections: [] },
    { limit: 1, fetchResource },
  );
  assert.equal(downloads, 1);
  assert.equal(
    (await store.get("token", address("9") + ":2")).image,
    first.image,
  );
});

test("large inline artwork is cached and reused without exceeding index tuple limits", async (t) => {
  const db = await testDatabase(t), pool = db.pool();
  await migrate(pool);
  const store = new PgStore(pool);
  await store.applyBlock(block(1, "2"));
  const image = "data:image/png;base64," + randomBytes(24000).toString("base64");
  await refreshMetadata(store, { contract: async () => uriFelts({ name: "Inline art", image }) }, { chain: "LOCAL" }, { limit: 1 });
  const token = await store.get("token", address("9") + ":1");
  assert.ok(token.image);
  assert.equal(await store.cachedImage(image), token.image);
  assert.equal(await store.cachedImage(image + "different"), null);
});
