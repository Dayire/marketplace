import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeEvent,
  SELECTORS,
  DECODER_CAPABILITY,
  UNKNOWN_COLLECTION_EVENT,
} from "../src/decode.mjs";
import { summarizeAbi } from "../src/classify.mjs";
import { prepareBlock, recordQuarantine } from "../src/indexer.mjs";
import { projectEvent } from "../src/projection.mjs";
import { Store } from "../src/store.mjs";
import { collectionKey, collectionRecord } from "../src/collection-catalog.mjs";
import { ApiError, address } from "../src/domain.mjs";

const cfg = {
  chain: "LOCAL",
  marketplace: "0x99",
  collections: [{ address: "0x9" }],
};
const ENUM_EVENT_SELECTOR =
  "0x2d4fbe4956fedf49b5892807e00e7e9eea4680becba55f9187684a69e9424fa"; // sn_keccak("Event")

const ABI_CAIRO1_ENUM = [
  { type: "interface", name: "ISRC5" },
  { type: "function", name: "supports_interface", inputs: [] },
  {
    type: "event",
    name: "Event",
    kind: "enum",
    variants: [
      {
        name: "Transfer",
        type: "openzeppelin_token::erc721::erc721::ERC721Component::Transfer",
        kind: "enum",
      },
    ],
  },
  {
    type: "event",
    name: "openzeppelin_token::erc721::erc721::ERC721Component::Transfer",
    kind: "struct",
    members: [
      {
        name: "from",
        type: "core::starknet::contract_address::ContractAddress",
        kind: "key",
      },
      {
        name: "to",
        type: "core::starknet::contract_address::ContractAddress",
        kind: "key",
      },
      { name: "token_id", type: "core::integer::u256", kind: "key" },
    ],
  },
];
const ABI_CAIRO1_STRUCT = [
  { type: "function", name: "supports_interface", inputs: [] },
  {
    type: "event",
    name: "ERC721Component::Approval",
    kind: "struct",
    members: [
      {
        name: "owner",
        type: "core::starknet::contract_address::ContractAddress",
        kind: "key",
      },
      { name: "token_id", type: "core::integer::u256", kind: "key" },
      {
        name: "spender",
        type: "core::starknet::contract_address::ContractAddress",
        kind: "data",
      },
    ],
  },
];
const ABI_CAIRO0 = [
  { type: "function", name: "supports_interface", inputs: [] },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "ContractAddress" },
      { name: "to", type: "ContractAddress" },
      { name: "token_id", type: "Uint256" },
    ],
  },
  {
    type: "event",
    name: "Approval",
    inputs: [
      { name: "owner", type: "ContractAddress" },
      { name: "spender", type: "ContractAddress" },
      { name: "token_id", type: "Uint256" },
    ],
  },
];
const ABI_ERC1155 = [
  { type: "function", name: "supports_interface", inputs: [] },
  {
    type: "event",
    name: "ERC1155Component::Transfer",
    kind: "struct",
    members: [
      {
        name: "from",
        type: "core::starknet::contract_address::ContractAddress",
        kind: "key",
      },
      {
        name: "to",
        type: "core::starknet::contract_address::ContractAddress",
        kind: "key",
      },
      { name: "id", type: "core::integer::u256", kind: "key" },
      { name: "value", type: "core::integer::u256", kind: "data" },
    ],
  },
];
const ABI_UNRELATED = [
  { type: "function", name: "get_config", inputs: [] },
  { type: "event", name: "Paused", inputs: [{ name: "paused", type: "felt" }] },
];

test("enum-nested component events resolve through configured wrappers", () => {
  const summary = summarizeAbi(ABI_CAIRO1_ENUM, { classHash: "0xabc" });
  const raw = {
    from_address: "0x9",
    keys: [
      ENUM_EVENT_SELECTOR,
      SELECTORS.Transfer,
      "0x0",
      "0x2",
      "5",
      "0",
    ],
    data: [],
  };
  const event = decodeEvent(raw, cfg, summary);
  assert.equal(event.type, "transfer");
  assert.equal(event.from, address("0x0"));
  assert.equal(event.to, address("0x2"));
  assert.equal(event.tokenId, "5", "u256 low/high across keys keeps precision");
  assert.equal(event.decoderVersion, DECODER_CAPABILITY);
  assert.equal(
    event.decoder,
    "nft-members.v2",
    "members drive the layout even when the selector came from an enum wrapper",
  );
  assert.equal(event.raw, raw, "raw evidence stays attached for replay");

  // Enum wrapper without member detail falls back to the fixed-order adapter.
  const enumOnly = summarizeAbi(
    ABI_CAIRO1_ENUM.filter((item) => item.kind !== "struct"),
    { classHash: "0xabc" },
  );
  const flattened = decodeEvent(raw, cfg, enumOnly);
  assert.equal(flattened.tokenId, "5");
  assert.equal(flattened.decoder, "nft-enum.v2");
});

test("member-driven layouts decode keyed/data interleaves that flattening misreads", () => {
  const summary = summarizeAbi(ABI_CAIRO1_STRUCT, { classHash: "0xabc" });
  const raw = {
    from_address: "0x9",
    keys: [SELECTORS.Approval, "0x7", "7", "0"],
    data: ["0x8"],
  };
  const event = decodeEvent(raw, cfg, summary);
  assert.equal(event.type, "approval");
  assert.equal(event.owner, address("0x7"));
  assert.equal(event.tokenId, "7");
  assert.equal(
    event.spender,
    address("0x8"),
    "data member is read from data, not from the flattened key stream",
  );
  assert.equal(event.decoder, "nft-members.v2");

  // Snake/camel member naming is irrelevant: types drive the decode.
  const camel = summarizeAbi(
    ABI_CAIRO1_STRUCT.map((item) =>
      item.type === "event" && item.members
        ? {
            ...item,
            members: item.members.map((m) => ({
              ...m,
              name: m.name.replace(/_(\w)/g, (_, c) => c.toUpperCase()),
            })),
          }
        : item,
    ),
    { classHash: "0xabc" },
  );
  assert.deepEqual(
    { ...decodeEvent(raw, cfg, camel), raw: null },
    { ...event, raw: null },
    "snake_case and camelCase member names decode identically",
  );
});

test("historical adapter changes: old class and new class decode their era's layout", () => {
  const oldSummary = summarizeAbi(ABI_CAIRO0, { classHash: "0xold" });
  const newSummary = summarizeAbi(ABI_CAIRO1_ENUM, { classHash: "0xnew" });
  const oldRaw = {
    from_address: "0x9",
    keys: [SELECTORS.Transfer],
    data: ["0x1", "0x2", "1038", "0"],
  };
  const newRaw = {
    from_address: "0x9",
    keys: [SELECTORS.Transfer, "0x1", "0x2", "1038", "0"],
    data: [],
  };
  const fromOld = decodeEvent(oldRaw, cfg, oldSummary);
  const fromNew = decodeEvent(newRaw, cfg, newSummary);
  assert.deepEqual({ ...fromOld, raw: null }, { ...fromNew, raw: null });
  assert.equal(fromOld.tokenId, "1038");
  assert.equal(fromOld.decoder, "nft-members.v2");
  assert.equal(fromNew.decoder, "nft-members.v2");
  // The same raw decoded under the wrong era's layout must fail closed
  // instead of producing a misassigned token.
  assert.throws(
    () => decodeEvent(oldRaw, cfg, newSummary),
    (error) => error instanceof ApiError && error.code === "INVALID_EVENT",
  );
});

test("Cairo 0 layout still decodes without any ABI context", () => {
  const raw = {
    from_address: "0x9",
    keys: [SELECTORS.Transfer],
    data: ["0x1", "0x2", "5", "0"],
  };
  const event = decodeEvent(raw, cfg);
  assert.equal(event.tokenId, "5");
  assert.equal(event.decoder, "nft-flat.v2");
  assert.equal(event.decoderVersion, DECODER_CAPABILITY);
});

test("undecodable collection events refuse with context, stay legacy without it", () => {
  const summary = summarizeAbi(ABI_UNRELATED, { classHash: "0xabc" });
  const unknown = { from_address: "0x9", keys: ["0xf00d"], data: [] };
  assert.throws(
    () => decodeEvent(unknown, cfg, summary),
    (error) =>
      error.code === UNKNOWN_COLLECTION_EVENT &&
      error.message.includes("0xf00d"),
    "with ABI context an unsupported event is refused, not dropped",
  );
  assert.equal(
    decodeEvent(unknown, cfg),
    null,
    "without ABI context the legacy null contract holds",
  );
  // Known selector that is not an NFT event: also refused with context.
  assert.throws(
    () =>
      decodeEvent(
        { from_address: "0x9", keys: [SELECTORS.allowance], data: ["0x1"] },
        cfg,
        summary,
      ),
    (error) => error.code === UNKNOWN_COLLECTION_EVENT,
  );
  // Malformed modeled event keeps failing closed.
  assert.throws(
    () =>
      decodeEvent(
        { from_address: "0x9", keys: [SELECTORS.Transfer], data: ["0x1"] },
        cfg,
        summarizeAbi(ABI_CAIRO0, { classHash: "0xabc" }),
      ),
    (error) => error.code === "INVALID_EVENT",
  );
});

test("ERC-1155 transfers decode distinctly and project no 721 ownership", () => {
  const summary = summarizeAbi(ABI_ERC1155, { classHash: "0xabc" });
  const raw = {
    from_address: "0x9",
    keys: [SELECTORS.Transfer, "0x1", "0x2", "3", "0"],
    data: ["7", "0"],
  };
  const event = decodeEvent(raw, cfg, summary);
  assert.equal(event.type, "erc1155_transfer");
  assert.equal(event.tokenId, "3");
  assert.equal(event.value, "7");
  assert.equal(event.decoder, "nft-members.v2");
  const provenance = {
    blockNumber: 4,
    blockHash: "0xb",
    transactionHash: "0x1",
    eventIndex: 0,
    timestamp: 100,
  };
  const writes = [];
  projectEvent(
    event,
    provenance,
    () => null,
    (kind) => writes.push(kind),
  );
  assert.deepEqual(writes, [], "no token row is invented for ERC-1155 transfers");
  const undecodable = {
    type: "undecodable",
    collection: "0x9",
    raw,
    decoderVersion: DECODER_CAPABILITY,
  };
  projectEvent(undecodable, provenance, () => null, (kind) =>
    writes.push(kind),
  );
  assert.deepEqual(writes, [], "raw-only rows project no market state");
});

test("prepareBlock quarantines unsupported collection events and keeps raw", () => {
  const summary = summarizeAbi(ABI_UNRELATED, { classHash: "0xabc" });
  const context = new Map([[address("0x9"), summary]]);
  const sources = [
    { address: address("0x9"), start: 1 },
    { address: address("0x99"), start: 1 },
  ];
  const raw = {
    from_address: "0x9",
    keys: ["0xf00d"],
    data: ["0x1"],
    block_number: 3,
    block_hash: "0xabc",
    transaction_hash: "0x1",
  };
  const found = new Map([[3, [raw]]]);
  const block = {
    block_number: 3,
    block_hash: "0xabc",
    parent_hash: "0x2",
    timestamp: 1000,
    transactions: [
      {
        receipt: {
          transaction_hash: "0x1",
          execution_status: "SUCCEEDED",
          events: [raw],
        },
      },
    ],
  };
  const prepared = prepareBlock(3, block, found, sources, cfg, 1, context);
  assert.equal(prepared.quarantined.length, 1);
  assert.equal(prepared.quarantined[0].collection, address("0x9"));
  assert.equal(prepared.quarantined[0].code, UNKNOWN_COLLECTION_EVENT);
  assert.equal(prepared.quarantined[0].block, 3);
  const placeholder = prepared.events[0];
  assert.equal(placeholder.type, "undecodable", "raw stays replayable");
  assert.deepEqual(placeholder.raw, raw);
  assert.equal(placeholder.transactionHash, "0x1");
  assert.equal(placeholder.eventIndex, 0);

  // Marketplace decode failures remain fatal.
  const badMarket = {
    from_address: "0x99",
    keys: [SELECTORS.FeePolicyChanged],
    data: ["500"],
    block_number: 3,
    block_hash: "0xabc",
    transaction_hash: "0x1",
  };
  assert.throws(() =>
    prepareBlock(
      3,
      { ...block, transactions: [{ receipt: { ...block.transactions[0].receipt, events: [badMarket] } }] },
      new Map([[3, [badMarket]]]),
      sources,
      cfg,
      1,
      context,
    ),
  );

  // Without ABI context the legacy drop path stays silent (no false quarantine).
  const legacy = prepareBlock(
    3,
    block,
    found,
    sources,
    cfg,
    1,
    new Map(),
  );
  assert.equal(legacy.quarantined.length, 0);
  assert.deepEqual(legacy.events, []);
});

test("recordQuarantine fails the collection open with bounded evidence", async () => {
  const store = new Store(":memory:");
  const id = collectionKey("0x1", address("0x9"));
  const body = collectionRecord({
    chainId: "0x1",
    address: address("0x9"),
    state: "candidate",
    standard: null,
    deployment: null,
    classHistory: [],
    classification: null,
    decoderVersion: null,
    replayGeneration: 1,
  });
  store.put("catalog_collection", id, body, 1);
  const config = { chainId: "0x1" };
  const entry = {
    collection: address("0x9"),
    block: 3,
    transactionHash: "0x1",
    eventIndex: 0,
    code: UNKNOWN_COLLECTION_EVENT,
    message: "Unsupported collection event 0xf00d",
    selector: "0xf00d",
  };
  const written = await recordQuarantine(store, config, [entry]);
  assert.equal(written, 1);
  const failed = store.get("catalog_collection", id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.quarantine.observations, 1);
  assert.equal(failed.quarantine.first.block, 3);
  assert.equal(failed.quarantine.last.selector, "0xf00d");
  assert.equal(failed.standard, null, "identity fields survive the patch");
  await recordQuarantine(store, config, [{ ...entry, block: 5 }]);
  const again = store.get("catalog_collection", id);
  assert.equal(again.quarantine.observations, 2);
  assert.equal(again.quarantine.first.block, 3, "first evidence is retained");
  assert.equal(again.quarantine.last.block, 5);
  // Re-running the same range must not invent new evidence rows.
  await recordQuarantine(store, config, [{ ...entry, block: 3 }]);
  const stable = store.get("catalog_collection", id);
  assert.equal(stable.quarantine.observations, 3, "observations count replays");
  await store.close();
});
