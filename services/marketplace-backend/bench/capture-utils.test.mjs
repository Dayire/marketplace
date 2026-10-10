import { test } from "node:test";
import assert from "node:assert/strict";
import { readMethod, validateWindow, verifyCoverage } from "./capture-utils.mjs";
const raw = { from_address: "0x9", keys: ["0x1"], data: ["0x2"] };
const block = { block_number: 1, block_hash: "0x11", parent_hash: "0x10", status: "ACCEPTED_ON_L2", transactions: [{ receipt: { transaction_hash: "0x3", execution_status: "SUCCEEDED", events: [raw] } }] };
test("capture refuses chain writes and incomplete/pending receipt windows", () => {
  assert.throws(() => readMethod("starknet_addInvokeTransaction"));
  readMethod("starknet_getBlockWithReceipts");
  assert.throws(() => validateWindow([], 1, 1));
  assert.throws(() => validateWindow([{ ...block, status: "PRE_CONFIRMED" }], 1, 1));
  validateWindow([block], 1, 1);
});
test("capture requires duplicate-preserving receipt/event parity", () => {
  const filtered = [{ ...raw, transaction_hash: "0x3", block_hash: "0x11" }];
  assert.equal(verifyCoverage([block], filtered, ["0x09"]), 1);
  assert.throws(() => verifyCoverage([block], [], ["0x9"]));
  assert.throws(() => verifyCoverage([block], [...filtered, ...filtered], ["0x9"]));
});
