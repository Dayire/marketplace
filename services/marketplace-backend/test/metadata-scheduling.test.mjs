import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { address } from "../src/domain.mjs";
import {
  metadataCandidates,
  expandMetadataJobs,
  claimMetadataJob,
  completeMetadataJob,
} from "../src/metadata-store.mjs";

const A = address("0xa1"), B = address("0xb1");
const token = (collection, i) => ({
  id: `${collection}:${i}`,
  collection,
  tokenId: String(i),
  owner: address("2"),
  metadataNextAttempt: 0,
  updatedAt: { blockHash: "0xabc", transactionHash: "0x1", eventIndex: 0 },
});

test("a large collection cannot hide eligible metadata from another collection", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  for (let i = 0; i < 150; i++) store.put("token", `${A}:${i}`, token(A, i));
  for (let i = 0; i < 6; i++) store.put("token", `${B}:${i}`, token(B, i));
  const picked = await metadataCandidates(store, 1000, 6, 3);
  assert.equal(picked.length, 6, "eligible work should fill the bounded pass");
  assert.deepEqual(
    [A, B].map((a) => picked.filter((item) => item.collection === a).length),
    [3, 3],
  );
});

test("fair candidates retain explicit job priority, retry backoff and leases", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  for (const collection of [A, B])
    for (let i = 0; i < 4; i++) store.put("token", `${collection}:${i}`, token(collection, i));
  store.put("token", `${A}:0`, { ...token(A, 0), metadataNextAttempt: 5000 });
  store.put("token", `${A}:1`, { ...token(A, 1), metadataNextAttempt: 5000 });
  store.put("metadata_job", `${A}:1`, { state: "pending" });
  store.put("metadata_job", `${B}:0`, { state: "running", leaseUntil: 5000 });
  const picked = await metadataCandidates(store, 1000, 4, 2);
  assert.equal(picked.length, 4);
  assert.ok(picked.some((item) => item.id === `${A}:1`));
  assert.ok(!picked.some((item) => item.id === `${A}:0`));
  assert.ok(!picked.some((item) => item.id === `${B}:0`));
});

test("range expansion rotates collections and preserves in-flight jobs", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  for (let i = 0; i < 250; i++) store.put("token", `${A}:${i}`, token(A, i));
  store.put("token", `${B}:0`, token(B, 0));
  for (const collection of [A, B])
    store.put("metadata_job", `${collection}:*`, { collection, state: "pending" });
  store.put("metadata_job", `${A}:0`, {
    state: "running", lease: "existing-worker", leaseUntil: Date.now() + 60000,
  });
  await expandMetadataJobs(store);
  assert.equal(store.get("metadata_job", `${A}:0`).lease, "existing-worker");
  await expandMetadataJobs(store);
  assert.equal(store.get("metadata_job", `${B}:0`).state, "pending");
  assert.equal(store.get("metadata_job", `${B}:*`).state, "complete");
  assert.equal(store.get("metadata_job", `${A}:*`).state, "pending");
});

test("metadata completion rejects a newer token event in the same block", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const original = token(A, 0);
  store.put("token", original.id, original);
  const claim = await claimMetadataJob(store, original, 1000);
  store.put("token", original.id, {
    ...original,
    owner: address("3"),
    updatedAt: { ...original.updatedAt, transactionHash: "0x2", eventIndex: 1 },
  });
  await completeMetadataJob(store, original, claim, {
    metadataStatus: "ready", metadata: { name: "stale" },
  });
  const current = store.get("token", original.id);
  assert.equal(current.owner, address("3"));
  assert.equal(current.metadata?.name, undefined);
});

test("ERC1155 metadata is deduplicated by token, shares quotas and survives owner changes without inventing an ERC721 token", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  for (const owner of [address("2"), address("3")])
    for (let i = 0; i < 120; i++) {
      const body = { ...token(A, i), owner, balance: "7", balanceFelts: ["0x7", "0x0"] };
      store.put("erc1155_balance", `${A}:${i}:${owner}`, body);
    }
  for (let i = 0; i < 3; i++) store.put("token", `${B}:${i}`, token(B, i));
  const picked = await metadataCandidates(store, 1000, 6, 3);
  assert.equal(picked.length, 6);
  const erc1155 = picked.filter((item) => item.collection === A);
  assert.equal(erc1155.length, 3);
  assert.equal(new Set(erc1155.map((item) => item.id)).size, 3);
  assert.ok(erc1155.every((item) => item.standard === "ERC1155"));
  const item = erc1155[0], claim = await claimMetadataJob(store, item, 1000);
  await completeMetadataJob(store, item, claim, { metadataStatus: "ready", metadata: { name: "Multi token" }, metadataNextAttempt: 5000 });
  assert.equal(store.get("token", item.id), null);
  assert.equal(store.get("token_metadata", item.id).metadata.name, "Multi token");
  assert.ok(!(await metadataCandidates(store, 1000, 100, 50)).some((entry) => entry.id === item.id));
});
