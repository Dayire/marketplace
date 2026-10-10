import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { testDatabase } from "./helpers.mjs";
import { migrate } from "../../src/postgres/migrate.mjs";
import { PgStore } from "../../src/postgres/store.mjs";
import { address, MAX_U256, orderKey } from "../../src/domain.mjs";
import { preflight } from "../../src/preflight.mjs";
import { collectionRecord } from "../../src/collection-catalog.mjs";

const collection = address("1155"), alice = address("10"), bob = address("11");
const zero = address("0"), id = MAX_U256.toString();
const key = (owner, tokenId = id) => `${collection}:${tokenId}:${owner}`;
const block = (number, events = [], extra = {}) => ({
  number, hash: `0x${number.toString(16)}`, parentHash: `0x${(number - 1).toString(16)}`,
  timestamp: number + 100, events, sources: [collection],
  sourceStarts: { [collection]: 1 }, ...extra,
});
const single = (from, to, value, tokenId = id) => ({
  type: "erc1155_transfer", collection, from, to, tokenId, value: String(value),
});
const batch = (from, to, ids, values) => ({
  type: "erc1155_batch_transfer", collection, from, to, ids, values: values.map(String),
});
async function fixture(t) {
  const db = await testDatabase(t), pool = db.pool();
  await migrate(pool);
  return { db, pool, store: new PgStore(pool) };
}

test("PostgreSQL repeated ERC1155 batch IDs read prior writes losslessly; replay, connection restart and reorg preserve balances", async (t) => {
  const { db, pool, store } = await fixture(t);
  await store.applyBlock(block(1, [single(zero, alice, MAX_U256)]));
  const large = 2n ** 200n + 1n, total = large + 7n;
  const moved = block(2, [batch(alice, bob, [id, id], [large, 7n])]);
  await store.applyBlock(moved);
  assert.equal((await store.get("erc1155_balance", key(alice))).balance, (MAX_U256 - total).toString());
  assert.equal((await store.get("erc1155_balance", key(bob))).balance, total.toString());
  assert.deepEqual((await store.get("erc1155_balance", key(bob))).balanceFelts, ["0x8", "0x1000000000000000000"]);
  assert.equal((await store.list("activity")).length, 2, "one activity per batch");
  const before = await store.list("erc1155_balance");
  await store.applyBlock({ ...moved, backfill: true });
  assert.deepEqual(await store.list("erc1155_balance"), before);
  assert.equal((await store.list("activity")).length, 2);
  const reopenedPool = new pg.Pool({ connectionString: db.url, max: 2 });
  const reopened = new PgStore(reopenedPool);
  try { assert.deepEqual(await reopened.list("erc1155_balance"), before); }
  finally { await reopenedPool.end(); }
  await pool.query("INSERT INTO app.app_meta VALUES('keep',$1)", [{ humanData: "preserve" }]);
  await store.rewind(1);
  assert.equal((await store.get("erc1155_balance", key(alice))).balance, MAX_U256.toString());
  assert.equal(await store.get("erc1155_balance", key(bob)), null);
  assert.equal((await store.list("activity")).length, 1);
  assert.equal((await pool.query("SELECT value FROM app.app_meta WHERE key='keep'")).rows[0].value.humanData, "preserve");
  await store.applyBlock({ ...moved, hash: "0x22" });
  assert.equal((await store.get("erc1155_balance", key(bob))).balance, total.toString());
});

test("PostgreSQL ERC1155 self-transfers preserve balance and require sufficient holdings", async (t) => {
  const { store } = await fixture(t);
  await store.applyBlock(block(1, [single(zero, alice, 10)]));
  await store.applyBlock(block(2, [batch(alice, alice, [id, id], [3, 4])]));
  assert.equal((await store.get("erc1155_balance", key(alice))).balance, "10");
  await assert.rejects(store.applyBlock(block(3, [single(alice, alice, 11)])), { code: "NEGATIVE_BALANCE" });
  assert.equal((await store.head()).number, 2);
});

test("PostgreSQL malformed batch, underflow and uint256 overflow roll back journal, balances and checkpoint", async (t) => {
  const { pool, store } = await fixture(t);
  await store.applyBlock(block(1, [single(zero, alice, MAX_U256)]));
  const before = await store.list("erc1155_balance");
  for (const event of [
    batch(alice, bob, [id], [1, 2]),
    batch(alice, bob, [id, "2"], [1, 1]),
    single(zero, alice, 1),
  ]) {
    await assert.rejects(store.applyBlock(block(2, [single(zero, bob, 5, "3"), event])));
    assert.deepEqual(await store.list("erc1155_balance"), before);
    assert.equal((await store.head()).number, 1);
    assert.equal((await store.get("progress", collection)).block, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM chain.events")).rows[0].n, 1);
  }
});

test("PostgreSQL ERC1155 balance schema rejects noncanonical integers/identity and offers exact indexed columns", async (t) => {
  const { pool, store } = await fixture(t);
  await store.applyBlock(block(1, [single(zero, alice, MAX_U256)]));
  const row = await store.get("erc1155_balance", key(alice));
  for (const patch of [{ balance: "1.5" }, { balance: "01" }, { balance: (MAX_U256 + 1n).toString() }, { tokenId: "01" }, { owner: "0xa" }, { balanceFelts: ["0x0", "0x100000000000000000000000000000000"] }]) {
    await assert.rejects(store.put("erc1155_balance", key(alice), { ...row, ...patch }));
  }
  await assert.rejects(store.put("erc1155_balance", "wrong-identity", row));
  const columns = (await pool.query("SELECT collection, token_id::text, owner, balance::text FROM market.erc1155_balances")).rows[0];
  assert.deepEqual(columns, { collection, token_id: id, owner: alice, balance: MAX_U256.toString() });
});

test("PostgreSQL preflight awaits ERC1155 classification and rejects the cart before any RPC call", async (t) => {
  const { store } = await fixture(t), maker = address("20");
  const config = { chain: "LOCAL", chainId: "0x1", marketplace: address("99"), collections: [], currencies: [] };
  const order = { kind: "listing", state: "open", collection, tokenId: id, maker, nonce: "1", currency: address("30"), buyerDebit: "1", expiry: "9999999999", feeBps: 0 };
  await store.put("order", orderKey(config.chain, config.marketplace, maker, "1"), order);
  const record = collectionRecord({ chainId: "0x1", address: collection, standard: "ERC1155" });
  await store.put("catalog_collection", record.id, record);
  const rpc = { call: async () => { throw new Error("ERC1155 must not reach RPC"); } };
  const result = await preflight(store, rpc, config, { account: bob, items: [{ maker, nonce: "1" }] });
  assert.equal(result.canSubmit, false);
  assert.deepEqual(result.reasons, ["ERC1155_NOT_CHECKOUT_ELIGIBLE"]);
});

test("PostgreSQL historical overlay before oldest journal requires a pinned anchor and verified parent; normal continuity resumes", async (t) => {
  const { store } = await fixture(t);
  await store.applyBlock(block(10, [], { sources: [] }));
  const historic = block(1, [single(zero, alice, 8)], { backfill: true });
  await assert.rejects(store.applyBlock(historic), { code: "CHAIN_GAP" });
  for (const backfillAnchor of [
    { number: 10, hash: "0xa", parentHashVerified: true },
    { number: 10, hash: "0xb", parentHashVerified: historic.parentHash },
    { number: 10, hash: "0xa", parentHashVerified: "0x999" },
    { number: 9, hash: "0x9", parentHashVerified: historic.parentHash },
  ]) await assert.rejects(store.applyBlock({ ...historic, backfillAnchor }), { code: "CHAIN_GAP" });
  await store.applyBlock({ ...historic, backfillAnchor: { number: 10, hash: "0xa", parentHashVerified: historic.parentHash } });
  assert.equal((await store.head()).number, 10, "live canonical head stays pinned");
  assert.equal((await store.get("erc1155_balance", key(alice))).balance, "8");
  await store.applyBlock(block(2, [single(alice, bob, 3)], { backfill: true }));
  assert.equal((await store.get("erc1155_balance", key(bob))).balance, "3");
  await assert.rejects(store.applyBlock(block(3, [], { backfill: true, parentHash: "0xbad" })), { code: "CHAIN_GAP" });
  await store.applyBlock(block(2, [single(alice, bob, 3)], { backfill: true }));
  assert.equal((await store.get("erc1155_balance", key(bob))).balance, "3");
  await store.rewind(1);
  assert.equal((await store.head()).number, 1);
  assert.equal((await store.get("erc1155_balance", key(alice))).balance, "8");
  assert.equal(await store.get("erc1155_balance", key(bob)), null);
});
