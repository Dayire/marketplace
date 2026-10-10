import { test } from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./helpers.mjs";
import { migrate, SCHEMA_VERSION } from "../../src/postgres/migrate.mjs";
import { PgStore } from "../../src/postgres/store.mjs";
import { collectionRecord } from "../../src/collection-catalog.mjs";
import { address, MAX_U256, u256Felts } from "../../src/domain.mjs";
import { selectorFromName } from "../../src/starknet-selector.mjs";
import { reconcileCollection } from "../../src/legacy-coverage.mjs";

const collection = address("0x1155"), alice = address("0xa"), bob = address("0xb"), zero = address("0");
const tokenId = MAX_U256.toString(), config = { chain: "LOCAL", chainId: "0x1", collections: [], currencies: [] };
const fn = (name, inputs, output) => ({ type: "function", name, inputs: inputs.map(([name, type]) => ({ name, type })), outputs: [{ type: output }] });
const ownerAbi = [fn("owner_of", [["token_id", "core::integer::u256"]], "core::starknet::contract_address::ContractAddress")];
const balanceAbi = [fn("balance_of", [["account", "core::starknet::contract_address::ContractAddress"], ["token_id", "core::integer::u256"]], "core::integer::u256")];
const block = (number, events) => ({ number, hash: `0x${number.toString(16)}`, parentHash: `0x${(number - 1).toString(16)}`, timestamp: number + 100,
  events, sources: [collection], sourceStarts: { [collection]: 1 } });

async function fixture(t, standard) {
  const db = await testDatabase(t), pool = db.pool(); await migrate(pool);
  const store = new PgStore(pool), source = collectionRecord({ chainId: "0x1", address: collection, standard, state: "syncing" });
  await store.put("catalog_collection", source.id, source);
  return { pool, store };
}
function rpcFixture({ abi, number = 1, owners = new Map([[tokenId, alice]]), balances = new Map(), onCall } = {}) {
  const calls = [];
  return { calls, async call(method, p) {
    calls.push({ method, params: p }); await onCall?.(method, p);
    if (method === "starknet_chainId") return "0x1";
    assert.deepEqual(p.block_id, { block_hash: `0x${number.toString(16)}` });
    if (method === "starknet_getBlockWithTxHashes") return { block_number: number, block_hash: `0x${number.toString(16)}` };
    if (method === "starknet_getClassHashAt") return "0x999";
    if (method === "starknet_getClass") return { abi };
    if (method === "starknet_call") {
      const args = p.request.calldata;
      assert.ok(args.every((felt) => /^0x[0-9a-f]+$/.test(felt)), "RPC calldata uses hexadecimal field elements");
      if (p.request.entry_point_selector === selectorFromName("owner_of")) return [owners.get((BigInt(args[0]) + (BigInt(args[1]) << 128n)).toString())];
      assert.equal(p.request.entry_point_selector, selectorFromName("balance_of"));
      const id = (BigInt(args[1]) + (BigInt(args[2]) << 128n)).toString();
      return u256Felts(balances.get(`${address(args[0])}:${id}`) ?? "0");
    }
    throw new Error(`Unexpected ${method}`);
  }};
}

test("PostgreSQL owner reconciliation is pinned, lossless and removed by canonical rewind", async (t) => {
  const { pool, store } = await fixture(t, "ERC721");
  await store.applyBlock(block(1, [{ type: "transfer", collection, from: zero, to: alice, tokenId }]));
  const result = await reconcileCollection(store, rpcFixture({ abi: ownerAbi }), config, { collection, blockNumber: 1, blockHash: "0x1" });
  assert.equal(result.ok, true); assert.equal(result.checked, 1); assert.equal(result.projectedCount, "1");
  assert.equal(result.confidence, "partial");
  assert.deepEqual(await store.get("status", `reconciliation:${collection}`), result);
  assert.equal((await pool.query("SELECT max(version)::int AS v FROM public.marketplace_migrations")).rows[0].v, SCHEMA_VERSION);
  await store.rewind(0);
  assert.equal(await store.get("status", `reconciliation:${collection}`), null);
});

test("PostgreSQL ERC1155 reconciliation checks zero and high balances using an indexed bounded collection scan", async (t) => {
  const { pool, store } = await fixture(t, "ERC1155");
  const single = (from, to, value) => ({ type: "erc1155_transfer", collection, from, to, tokenId, value: value.toString() });
  await store.applyBlock(block(1, [single(zero, alice, MAX_U256)]));
  await store.applyBlock(block(2, [single(alice, bob, MAX_U256)]));
  const rpc = rpcFixture({ abi: balanceAbi, number: 2, balances: new Map([[`${bob}:${tokenId}`, MAX_U256.toString()]]) });
  const result = await reconcileCollection(store, rpc, config, { collection, blockNumber: 2, blockHash: "0x2", limit: 2 });
  assert.equal(result.ok, true); assert.equal(result.checked, 2); assert.equal(result.projectedCount, "2");
  assert.equal(result.confidence, "partial");
  assert.equal(rpc.calls.filter((item) => item.method === "starknet_call").length, 2);
  const client = await pool.connect();
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL enable_seqscan=off");
    const plan = (await client.query("EXPLAIN (FORMAT JSON) SELECT body FROM market.erc1155_balances WHERE collection=$1 ORDER BY token_id,owner LIMIT $2", [collection, 2])).rows[0]["QUERY PLAN"];
    assert.match(JSON.stringify(plan), /erc1155_balances_reconciliation/, "zero balances use the complete lookup index");
    await client.query("ROLLBACK");
  } finally { client.release(); }
});

test("PostgreSQL reconciliation errors block promotion and a concurrent rewind cannot persist stale success", async (t) => {
  const { store } = await fixture(t, "ERC721");
  await store.applyBlock(block(1, [{ type: "transfer", collection, from: zero, to: alice, tokenId }]));
  let changed = false;
  const rpc = rpcFixture({ abi: ownerAbi, onCall: async (method) => {
    if (method === "starknet_call" && !changed) { changed = true; await store.rewind(0); }
  }});
  const result = await reconcileCollection(store, rpc, config, { collection, blockNumber: 1, blockHash: "0x1" });
  assert.equal(result.ok, false); assert.equal(result.state, "unavailable");
  assert.ok(result.errors.some((item) => item.code === "PROJECTION_CHANGED"));
  assert.equal(await store.get("status", `reconciliation:${collection}`), null);
});
