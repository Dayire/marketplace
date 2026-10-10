import { createHash } from "node:crypto";
export const READ_METHODS = new Set([
  "starknet_chainId", "starknet_specVersion", "starknet_getBlockWithTxHashes",
  "starknet_getBlockWithReceipts", "starknet_getEvents", "starknet_getClassHashAt",
  "starknet_getClass", "starknet_call",
]);
export function readMethod(method) {
  if (!READ_METHODS.has(method)) throw new Error("Only explicitly allowed public reads may be captured.");
}
export const digest = (value) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const hex = (value) => BigInt(value).toString(16);
export function validateWindow(blocks, from, to) {
  if (blocks.length !== to - from + 1) throw new Error("Incomplete receipt window.");
  for (const [index, block] of blocks.entries()) {
    if (block.block_number !== from + index || !["ACCEPTED_ON_L1", "ACCEPTED_ON_L2"].includes(block.status)) throw new Error("Unaccepted or unordered block.");
    if (index && hex(block.parent_hash) !== hex(blocks[index - 1].block_hash)) throw new Error("Noncontiguous parent hash.");
    if (!Array.isArray(block.transactions)) throw new Error("Missing receipt transactions.");
    for (const transaction of block.transactions) if (!Array.isArray(transaction.receipt?.events)) throw new Error("Missing full receipt events.");
  }
}
export function verifyCoverage(blocks, filtered, addresses) {
  const allowed = new Set(addresses.map(hex));
  const signature = (raw, tx, hash) => JSON.stringify([hex(hash), hex(tx), hex(raw.from_address), raw.keys.map(hex), raw.data.map(hex)]);
  const actual = [];
  for (const block of blocks) for (const transaction of block.transactions) {
    const receipt = transaction.receipt;
    if (receipt.execution_status === "REVERTED") continue;
    const tx = receipt.transaction_hash ?? transaction.transaction?.transaction_hash;
    for (const raw of receipt.events) if (allowed.has(hex(raw.from_address))) actual.push(signature(raw, tx, block.block_hash));
  }
  const expected = filtered.map(event => signature(event, event.transaction_hash, event.block_hash));
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected.sort())) throw new Error("Filtered events and full receipts disagree.");
  return actual.length;
}
export function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { count: 0 };
  return { count: sorted.length, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)], max: sorted.at(-1), total: sorted.reduce((a, b) => a + b, 0) };
}
