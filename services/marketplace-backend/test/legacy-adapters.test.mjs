import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { summarizeAbi, classifyFromEvidence, classificationPatch } from "../src/classify.mjs";
import { decodeEvent, SELECTORS } from "../src/decode.mjs";
import { address, fromU256 } from "../src/domain.mjs";
import { Store } from "../src/store.mjs";
import { Catalog } from "../src/catalog.mjs";
import { collectionRecord } from "../src/collection-catalog.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/legacy-mainnet.json", import.meta.url), "utf8"));
const contractClass = (name) => fixture.classes.find((item) => item.name === name);
const receipt = (name) => fixture.receipts.find((item) => item.name === name);
const briqReceipt = receipt("briq-mint");
const mint = briqReceipt.receipt.events[0];
const ethTransfer = briqReceipt.receipt.events.at(-1);
const realms = address("0x07ae27a31bb6526e3de9cf02f081f6ce0615ac12a6d7b85ee58b8ad7947a2809");
const config = {
  chain: "SN_MAIN", chainId: fixture.chainId, marketplace: null,
  collections: [mint.from_address, ethTransfer.from_address, realms].map((value) => ({ address: address(value), startBlock: 0 })),
};
const sha256 = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("frozen public ABI and receipt digests preserve evidence provenance", () => {
  for (const item of fixture.classes) assert.equal(sha256(item.abi), item.abiSha256);
  for (const item of fixture.receipts) assert.equal(sha256(item.receipt), item.receiptSha256);
  assert.equal(briqReceipt.transactionIndex, 0);
  assert.equal(briqReceipt.blockNumber, 10708);
  assert.equal(receipt("loot-upgrade").receipt.events[0].data[0], contractClass("loot-after").classHash);
});

test("real Cairo 0 key/data ABI and camelCase NFT functions are usable evidence", () => {
  const item = contractClass("briq-initial-implementation");
  const summary = summarizeAbi(item.abi, { classHash: item.classHash });
  assert.deepEqual(summary.events.find((event) => event.name === "Transfer").members, [
    { name: "from_", kind: "data", type: "felt" },
    { name: "to_", kind: "data", type: "felt" },
    { name: "token_id_", kind: "data", type: "Uint256" },
  ]);
  const result = classifyFromEvidence({ summary });
  assert.equal(result.standard, "ERC721");
  assert.deepEqual(result.classification.aliases.owner_of, ["ownerOf"]);
});

test("felt address members of the real Briq transfer normalize while u256 stays lossless", () => {
  const item = contractClass("briq-initial-implementation");
  const transfer = item.abi.find((event) => event.type === "event" && event.name === "Transfer");
  // The expected layout comes directly from the frozen ABI, independently of
  // the summarizer under test above.
  const summary = { classHash: item.classHash, events: [{ name: "Transfer", members: transfer.data.map((member) => ({ ...member, kind: "data" })) }] };
  const event = decodeEvent(mint, config, summary);
  assert.equal(event.type, "transfer");
  assert.equal(event.from, address("0"));
  assert.equal(event.to, address(mint.data[1]));
  assert.equal(event.tokenId, fromU256(...mint.data.slice(2)));
  assert.ok(BigInt(event.tokenId) > (1n << 128n));
  const observation = fixture.observations.find((item) => item.name === "briq-owner-after-mint");
  assert.equal(event.to, address(observation.response.result[0]));
});

test("modern string-serialized ABI exposes methods nested inside interfaces", () => {
  const item = contractClass("realms");
  const summary = summarizeAbi(JSON.stringify(item.abi), { classHash: item.classHash });
  assert.ok(summary.functions.includes("owner_of"));
  assert.ok(summary.functions.includes("supports_interface"));
  assert.ok(!summary.functions.includes("total_supply"), "voting checkpoint supply is not NFT enumeration evidence");
  assert.equal(classifyFromEvidence({ summary }).standard, "ERC721");
  assert.equal(summary.events.find((event) => event.name === "Transfer").members[0].kind, "key");
});

test("the real OpenZeppelin approved address maps to spender only for Approval", () => {
  const item = contractClass("realms");
  const summary = summarizeAbi(item.abi, { classHash: item.classHash });
  const approval = decodeEvent({ from_address: realms, keys: [SELECTORS.Approval, "0x12", "0x34", "0x56", "0"], data: [] }, config, summary);
  assert.equal(approval.type, "approval");
  assert.equal(approval.owner, address("0x12"));
  assert.equal(approval.spender, address("0x34"));
  const operator = decodeEvent({ from_address: realms, keys: [SELECTORS.ApprovalForAll, "0x12", "0x34"], data: ["1"] }, config, summary);
  assert.equal(operator.approved, true);
  assert.equal(operator.operator, address("0x34"));
});

test("a known selector absent from the historical ETH proxy ABI cannot use NFT fallback", () => {
  const item = contractClass("eth-historical-proxy");
  const summary = summarizeAbi(item.abi, { classHash: item.classHash });
  assert.equal(classifyFromEvidence({ summary }).standard, null);
  assert.throws(() => decodeEvent(ethTransfer, config, summary), (error) => error.code === "UNKNOWN_COLLECTION_EVENT");
});

test("actual pinned ETH implementation remains fungible and visible as an unsupported NFT candidate", (t) => {
  const item = contractClass("eth-implementation-10708"), summary = summarizeAbi(item.abi, { classHash: item.classHash });
  const classification = classifyFromEvidence({ summary });
  assert.equal(classification.standard, null);
  assert.equal(classification.classification.standard, "ERC20");
  assert.equal(classification.classification.uncertainty, "fungible");
  assert.throws(() => decodeEvent(ethTransfer, config, summary), (error) => error.code === "INVALID_EVENT");
  const store = new Store(":memory:"); t.after(() => store.close());
  const seed = collectionRecord({ chainId: fixture.chainId, address: ethTransfer.from_address });
  const source = collectionRecord({ ...seed, ...classificationPatch(seed, classification) });
  store.put("catalog_collection", source.id, source);
  const report = new Catalog(store, config).coverage();
  assert.equal(report.unsupported[0].address, address(ethTransfer.from_address));
  assert.equal(report.unsupported[0].reason, "fungible");
});

test("wrong-era keyed ABI refuses data-only Cairo 0 receipts", () => {
  const modern = contractClass("realms");
  assert.throws(() => decodeEvent(mint, config, summarizeAbi(modern.abi, { classHash: modern.classHash })), (error) => error.code === "INVALID_EVENT");
  const legacy = decodeEvent(mint, config);
  assert.equal(legacy.type, "transfer");
  assert.equal(legacy.to, address(mint.data[1]), "reviewed no-context legacy behavior is retained");
});

test("real deployment and upgrade administrative events do not quarantine NFT history", () => {
  const proxy = contractClass("briq-proxy");
  const summary = summarizeAbi(proxy.abi, { classHash: proxy.classHash });
  for (const event of receipt("briq-deployment").receipt.events.slice(0, 2))
    assert.equal(decodeEvent(event, config, summary), null);
  const loot = contractClass("loot-before");
  const upgrade = receipt("loot-upgrade").receipt.events[0];
  assert.equal(decodeEvent(upgrade, { ...config, collections: [...config.collections, { address: address(upgrade.from_address) }] }, summarizeAbi(loot.abi, { classHash: loot.classHash })), null);
  assert.throws(() => decodeEvent({ ...mint, keys: ["0xdeadbeef"] }, config, summary), (error) => error.code === "UNKNOWN_COLLECTION_EVENT");
});

test("real Briq Cairo 0 URI notification refreshes the exact u256 token", () => {
  const item = contractClass("briq-initial-implementation");
  const event = decodeEvent(briqReceipt.receipt.events[1], config, summarizeAbi(item.abi, { classHash: item.classHash }));
  assert.equal(event.type, "metadata_update");
  assert.equal(event.tokenId, fromU256(...mint.data.slice(2)));
  assert.throws(() => decodeEvent({ ...briqReceipt.receipt.events[1], data: ["5000"] }, config, summarizeAbi(item.abi)), (error) => error.code === "INVALID_EVENT");
});

test("fungible ABI semantics reject even an inconsistent NFT introspection claim", () => {
  const summary = summarizeAbi([
    { type: "function", name: "decimals" }, { type: "function", name: "transfer" },
    { type: "event", name: "Transfer", keys: [], data: [{ name: "from", type: "felt" }, { name: "to", type: "felt" }, { name: "value", type: "Uint256" }] },
  ]);
  const result = classifyFromEvidence({ summary, probes: [{ name: "erc721", supported: true }] });
  assert.equal(result.standard, null);
  assert.equal(result.classification.standard, "ERC20");
  assert.equal(result.classification.uncertainty, "fungible");
});
