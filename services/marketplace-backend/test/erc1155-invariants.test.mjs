import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { projectEvent, projectionReads } from "../src/projection.mjs";
import { address, MAX_U256 } from "../src/domain.mjs";
const collection = address("1155"), alice = address("10");
const provenance = { blockNumber: 1, blockHash: "0x1", transactionHash: "0x2", eventIndex: 0, timestamp: 10 };
function reducer() {
  const rows = new Map(), get = (kind, id) => rows.get(`${kind}:${id}`) ?? null;
  const put = (kind, id, value) => rows.set(`${kind}:${id}`, value);
  return { rows, get, apply: (event, p = provenance) => projectEvent(event, p, get, put) };
}
const single = (value, from = "0x0") => ({ type: "erc1155_transfer", collection, from, to: alice, tokenId: "1", value: String(value) });

test("ERC1155 reducer canonicalizes zero mint/burn addresses and does not create a zero-owner holding", () => {
  const { rows, get, apply } = reducer();
  apply(single(3));
  assert.equal(get("erc1155_balance", `${collection}:1:${alice}`).balance, "3");
  assert.equal(rows.size, 2);
  apply({ ...single(2, alice), to: "0x00" }, { ...provenance, eventIndex: 1 });
  assert.equal(get("erc1155_balance", `${collection}:1:${alice}`).balance, "1");
  assert.equal(get("erc1155_balance", `${collection}:1:${address("0")}`), null);
});

test("ERC1155 batch inputs validate both array lengths before any projection reads or writes", () => {
  for (const values of [["1", "2"], []]) {
    const event = { type: "erc1155_batch_transfer", collection, from: "0x0", to: alice, ids: ["1"], values };
    const { rows, apply } = reducer();
    assert.throws(() => apply(event), { code: "INVALID_EVENT" });
    assert.equal(rows.size, 0);
    assert.throws(() => projectionReads(event, provenance), { code: "INVALID_EVENT" });
  }
});

test("ERC1155 cumulative holdings cannot exceed uint256 even when individual event values fit", () => {
  const { get, apply } = reducer();
  apply(single(MAX_U256, address("0")));
  assert.throws(() => apply(single(1, address("0")), { ...provenance, eventIndex: 1 }), { code: "INVALID_INTEGER" });
  assert.equal(get("erc1155_balance", `${collection}:1:${alice}`).balance, MAX_U256.toString());
});

test("SQLite historical overlays require an existing pinned target and verified parent before older-than-journal writes", () => {
  const store = new Store(":memory:");
  try {
    const block = (number, extra = {}) => ({ number, hash: `0x${number.toString(16)}`, parentHash: `0x${(number - 1).toString(16)}`, timestamp: number + 10, events: [], ...extra });
    store.applyBlock(block(10));
    const first = block(1, { backfill: true, events: [single(5, address("0"))] });
    assert.throws(() => store.applyBlock(first), { code: "CHAIN_GAP" });
    assert.throws(() => store.applyBlock({ ...first, backfillAnchor: { number: 10, hash: "0xa", parentHashVerified: true } }), { code: "CHAIN_GAP" });
    store.applyBlock({ ...first, backfillAnchor: { number: 10, hash: "0xa", parentHashVerified: first.parentHash } });
    assert.equal(store.head().number, 10);
    assert.equal(store.get("erc1155_balance", `${collection}:1:${alice}`).balance, "5");
    store.applyBlock(block(2, { backfill: true }));
    assert.throws(() => store.applyBlock(block(3, { backfill: true, parentHash: "0xbad" })), { code: "CHAIN_GAP" });
    assert.equal(store.head().number, 10);
  } finally { store.close(); }
});
