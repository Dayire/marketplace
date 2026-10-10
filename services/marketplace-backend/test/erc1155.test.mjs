import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { scanOnce } from "../src/indexer.mjs";
import { decodeEvent, SELECTORS } from "../src/decode.mjs";
import { projectEvent, projectionReads } from "../src/projection.mjs";
import { preflight } from "../src/preflight.mjs";
import { orderKey, address } from "../src/domain.mjs";

const C = address("0xc1155");
const ALICE = address("0xa11ce");
const BOB = address("0xb0b");
const ZERO = address("0");

const summary = {
  events: [
    {
      name: "TransferSingle",
      members: [
        { name: "from", kind: "data", type: "core::starknet::contract_address::ContractAddress" },
        { name: "to", kind: "data", type: "core::starknet::contract_address::ContractAddress" },
        { name: "id", kind: "data", type: "core::integer::u256" },
        { name: "value", kind: "data", type: "core::integer::u256" },
      ],
    },
    {
      name: "BatchTransfer",
      members: [
        { name: "from", kind: "data", type: "core::starknet::contract_address::ContractAddress" },
        { name: "to", kind: "data", type: "core::starknet::contract_address::ContractAddress" },
        { name: "ids", kind: "data", type: "core::array::Array::<core::integer::u256>" },
        { name: "values", kind: "data", type: "core::array::Array::<core::integer::u256>" },
      ],
    },
  ],
};
const cfg = { chain: "LOCAL", chainId: "0x1", marketplace: null, collections: [{ address: C, startBlock: 0 }] };

const u256 = (n) => [`0x${(BigInt(n) & ((1n << 128n) - 1n)).toString(16)}`, `0x${(BigInt(n) >> 128n).toString(16)}`];

test("TransferSingle and BatchTransfer decode in both member-driven and legacy layouts", () => {
  const single = {
    from_address: C,
    keys: [SELECTORS.TransferSingle],
    data: [ALICE, BOB, ...u256(7), ...u256(5)],
  };
  const s = decodeEvent(single, cfg, summary);
  assert.equal(s.type, "erc1155_transfer");
  assert.equal(s.tokenId, "7");
  assert.equal(s.value, "5");

  const batch = {
    from_address: C,
    keys: [SELECTORS.BatchTransfer],
    data: [ALICE, BOB, "0x2", ...u256(1), ...u256(2), "0x2", ...u256(3), ...u256(4)],
  };
  const b = decodeEvent(batch, cfg, summary);
  assert.equal(b.type, "erc1155_batch_transfer");
  assert.deepEqual(b.ids, ["1", "2"]);
  assert.deepEqual(b.values, ["3", "4"]);

  // Same events without ABI context decode through the legacy flat adapter.
  const flatSingle = decodeEvent(single, cfg, null);
  assert.equal(flatSingle.type, "erc1155_transfer");
  assert.equal(flatSingle.decoder, "nft-flat.v2");
  const flatBatch = decodeEvent(batch, cfg, null);
  assert.deepEqual(flatBatch.ids, ["1", "2"]);

  const mismatched = {
    from_address: C,
    keys: [SELECTORS.BatchTransfer],
    data: [ALICE, BOB, "0x2", ...u256(1), ...u256(2), "0x3", ...u256(3), ...u256(4), ...u256(9)],
  };
  assert.throws(
    () => decodeEvent(mismatched, cfg, summary),
    (error) => error.code === "INVALID_EVENT",
    "length mismatch fails closed",
  );
});

test("projection credits and withdraws native balances and rejects negatives", () => {
  const rows = new Map();
  const get = (kind, id) => rows.get(`${kind}:${id}`) ?? null;
  const put = (kind, id, body) => rows.set(`${kind}:${id}`, body);
  const p = {
    blockNumber: 5,
    blockHash: "0xb5",
    transactionHash: "0xt5",
    eventIndex: 0,
    timestamp: 100,
  };

  projectEvent(
    { type: "erc1155_transfer", collection: C, from: ZERO, to: ALICE, tokenId: "1", value: "5" },
    p,
    get,
    put,
  );
  const minted = rows.get(`erc1155_balance:${C}:1:${ALICE}`);
  assert.equal(minted.balance, "5");
  assert.deepEqual(minted.balanceFelts, ["0x5", "0x0"], "native felt pair kept");

  assert.throws(
    () =>
      projectEvent(
        { type: "erc1155_transfer", collection: C, from: BOB, to: ALICE, tokenId: "9", value: "1" },
        { ...p, eventIndex: 1 },
        get,
        put,
      ),
    (error) => error.code === "NEGATIVE_BALANCE",
    "withdrawals cannot exceed holdings",
  );

  const replayId = `${p.blockHash}:${p.transactionHash}:${p.eventIndex}`;
  const balanceAfterMint = rows.get(`erc1155_balance:${C}:1:${ALICE}`).balance;
  projectEvent(
    { type: "erc1155_transfer", collection: C, from: ZERO, to: ALICE, tokenId: "1", value: "5" },
    p,
    get,
    put,
  );
  assert.equal(
    rows.get(`erc1155_balance:${C}:1:${ALICE}`).balance,
    balanceAfterMint,
    "an already-projected event never applies twice",
  );
  assert.ok(replayId);

  const reads = projectionReads(
    { type: "erc1155_batch_transfer", collection: C, from: ALICE, to: BOB, ids: ["1", "2"], values: ["3", "4"] },
    p,
  );
  assert.deepEqual(
    reads.map(([, key]) => key),
    [
      `${p.blockHash}:${p.transactionHash}:${p.eventIndex}`,
      `${C}:1:${ALICE}`,
      `${C}:1:${BOB}`,
      `${C}:2:${ALICE}`,
      `${C}:2:${BOB}`,
    ],
    "undo reads cover the dedupe marker and both sides of every id",
  );
});

function harness() {
  const hash = (n) => `0x${(100 + n).toString(16)}`;
  const ev = (n, tx, raw) => ({
    from_address: C,
    ...raw,
    block_number: n,
    block_hash: hash(n),
    transaction_hash: tx,
  });
  const mint1 = {
    keys: [SELECTORS.TransferSingle],
    data: [ZERO, ALICE, ...u256(1), ...u256(5)],
  };
  const mint2 = {
    keys: [SELECTORS.TransferSingle],
    data: [ZERO, ALICE, ...u256(2), ...u256(4)],
  };
  const batch = {
    keys: [SELECTORS.BatchTransfer],
    data: [ALICE, BOB, "0x2", ...u256(1), ...u256(2), "0x2", ...u256(2), ...u256(3)],
  };
  const burn = {
    keys: [SELECTORS.TransferSingle],
    data: [BOB, ZERO, ...u256(2), ...u256(3)],
  };
  const eventsByBlock = {
    1: [ev(1, "0xf1", mint1), ev(1, "0xf1", mint2)],
    2: [ev(2, "0xf2", batch)],
    3: [ev(3, "0xf3", burn)],
  };
  return {
    eventsByBlock,
    call: async (method, p) => {
      if (method === "starknet_chainId") return "0x1";
      if (method === "starknet_getClassHashAt") return "0x0def1";
      if (method === "starknet_getClass") return { abi: [] };
      if (method === "starknet_getEvents") {
        const lo = p.filter.from_block.block_number,
          hi = p.filter.to_block.block_number;
        const all = Object.values(eventsByBlock)
          .flat()
          .filter((event) => event.block_number >= lo && event.block_number <= hi);
        return { events: all };
      }
      const n = p.block_id === "latest" ? 5 : Number(p.block_id.block_number);
      const block = {
        block_number: n,
        block_hash: hash(n),
        parent_hash: n === 0 ? "0x0" : hash(n - 1),
        timestamp: 100 + n,
        status: "ACCEPTED_ON_L2",
        transactions: [],
      };
      if (method === "starknet_getBlockWithReceipts" && eventsByBlock[n])
        block.transactions = [
          {
            receipt: {
              transaction_hash: eventsByBlock[n][0].transaction_hash,
              execution_status: "SUCCEEDED",
              events: eventsByBlock[n].map((event) => ({
                from_address: event.from_address,
                keys: event.keys,
                data: event.data,
              })),
            },
          },
        ];
      return block;
    },
  };
}

test("an end-to-end mint, batch and burn keep balances and single activities", async () => {
  const store = new Store(":memory:");
  const rpc = harness();
  const first = await scanOnce(store, rpc, cfg, { window: 10 });
  assert.equal(first.indexed, 5);

  const list = (kind) => store.list(kind);
  const balances = new Map(
    list("erc1155_balance").map((row) => [`${row.tokenId}:${row.owner}`, row.balance]),
  );
  assert.equal(balances.get(`1:${ALICE}`), "3", "mint 5 minus batch send 2");
  assert.equal(balances.get(`1:${BOB}`), "2", "batch credit");
  assert.equal(balances.get(`2:${BOB}`), "0", "burn withdraws to zero, row kept");

  assert.equal(balances.get(`2:${ALICE}`), "1", "second mint minus batch send");
  assert.equal(
    list("activity").length,
    4,
    "one activity per event: two mints, one 2-id batch, one burn — the batch writes one row, not two",
  );

  // Replay through the overlay writer: balances and activities must not move.
  const before = JSON.stringify(list("erc1155_balance"));
  const activitiesBefore = list("activity").length;
  await scanOnce(store, rpc, cfg, {
    window: 10,
    scope: [C],
    from: 0,
    stopAt: first.indexed,
  });
  assert.equal(JSON.stringify(list("erc1155_balance")), before, "replay stable");
  assert.equal(list("activity").length, activitiesBefore, "no duplicate activities");
  store.close();
});

test("an ERC-1155 collection never enters ERC-721 checkout", async () => {
  const store = new Store(":memory:");
  const maker = address("0xbeef");
  const config = {
    chain: "LOCAL",
    chainId: "0x1",
    marketplace: "0x1",
    currencies: [],
  };
  const key = orderKey(config.chain, config.marketplace, maker, "1");
  store.put("order", key, { collection: C, maker, nonce: "1" });
  const record = {
    id: `0x1:${C}`,
    chainId: "0x1",
    address: C,
    state: "indexed",
    standard: "ERC1155",
    deployment: null,
    classHistory: [],
    classification: null,
    decoderVersion: null,
    replayGeneration: 1,
    visible: null,
    gaps: [],
    quarantine: null,
    runtimeErrors: [],
    retryCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  store.put("catalog_collection", record.id, record);

  const blocked = await preflight(store, null, config, {
    account: address("0xdead"),
    items: [{ maker, nonce: "1" }],
  });
  assert.equal(blocked.canSubmit, false);
  assert.deepEqual(blocked.reasons, ["ERC1155_NOT_CHECKOUT_ELIGIBLE"]);

  // Control: an ERC-721 record falls through to the normal status gate.
  store.put("catalog_collection", record.id, { ...record, standard: "ERC721" });
  const control = await preflight(store, null, config, {
    account: address("0xdead"),
    items: [{ maker, nonce: "1" }],
  });
  assert.ok(
    !control.reasons.includes("ERC1155_NOT_CHECKOUT_ELIGIBLE"),
    "ERC-721 carts are not blocked by the guard",
  );
  store.close();
});
