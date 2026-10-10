import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { classifyOnce } from "../src/classify-scan.mjs";
import {
  classificationPatch,
  classifyFromEvidence,
  needsClassification,
  summarizeAbi,
} from "../src/classify.mjs";
import {
  DISCOVERY_ADDRESS,
  discoveryKey,
  activeClassInterval,
} from "../src/discovery.mjs";
import { collectionKey, collectionRecord, sourceCoverage } from "../src/collection-catalog.mjs";
import { ApiError, address } from "../src/domain.mjs";

const CHAIN_ID = "0x1";
const CONFIG = { chain: "LOCAL", chainId: CHAIN_ID, marketplace: null, collections: [] };
const C = (n) => address("0x" + (0xc00000 + n).toString(16));
const CLASS = (n) => "0x" + (0xd00000 + n).toString(16);
const HASH = (n) => "0x" + (0x700000 + n).toString(16);
const BLOCK = 5;
const I = {
  isrc5: "0x3f918d17e5ee77373b56385708f855659a07f75997f365cf87748628532a055",
  erc721: "0x33eb2f84c309543403fd69f0d0f363781ef06ef6faeb0131ff16ea3175bd943",
  erc1155: "0x6114a8f75559e1b39fcba08ce02961a1aa082d9256a158dd3e64964e4b1b52",
  erc721Legacy: "0x80ac58cd",
  erc2981: "0x2d3414e45a8700c29f119a54b9f11dca0e29e06ddcb214018fc37340e165ed6",
};

const ERC721_ABI = [
  { type: "interface", name: "ISRC5" },
  { type: "function", name: "supports_interface", inputs: [{ name: "interface_id", type: "felt" }] },
  { type: "function", name: "balance_of", inputs: [{ name: "owner", type: "felt" }] },
  { type: "function", name: "owner_of", inputs: [{ name: "token_id", type: "u256" }] },
  { type: "function", name: "transfer_from", inputs: [] },
  { type: "function", name: "token_uri", inputs: [] },
  {
    type: "event",
    name: "openzeppelin_token::erc721::erc721::ERC721Component::Transfer",
    kind: "struct",
    members: [
      { name: "from", kind: "key" },
      { name: "to", kind: "key" },
      { name: "token_id", kind: "key" },
      { name: "value_unused", kind: "data" },
    ],
  },
];
const ERC20_ABI = [
  { type: "function", name: "transfer", inputs: [] },
  { type: "function", name: "balanceOf", inputs: [] },
  { type: "function", name: "decimals", inputs: [] },
  { type: "function", name: "symbol", inputs: [] },
  { type: "event", name: "Transfer", inputs: [{ name: "from" }, { name: "to" }, { name: "value" }] },
];
const PROXY_ABI = [{ type: "function", name: "get_implementation", inputs: [] }];
// Shared class: introspection only, so a non-matching address cannot be
// rescued by ABI markers (keeps the address-specific assertion honest).
const SHARED_ABI = [
  { type: "function", name: "supports_interface", inputs: [] },
  { type: "function", name: "balance_of", inputs: [] },
];
const IMPL_ABI = [
  { type: "function", name: "owner_of", inputs: [] },
  { type: "function", name: "transfer_from", inputs: [] },
];

function rpcError(code, message) {
  return new ApiError("RPC_CONTRACT_ERROR", message, 502, { rpcCode: code });
}

/**
 * contracts: { [address]: { classHash, supports?: {id: 1|0}, implementation? } }
 * classes: { [classHash]: abi }
 */
function harness({ contracts, classes }) {
  const counters = { getClass: 0, call: 0 };
  const abiOf = (addr) => classes[contracts[addr].classHash];
  return {
    counters,
    call: async (method, params) => {
      if (method === "starknet_getClassHashAt") {
        const c = contracts[params.contract_address];
        if (!c) throw rpcError(28, "Contract not found");
        return c.classHash;
      }
      if (method === "starknet_getClass") {
        counters.getClass++;
        const abi = classes[params.class_hash];
        if (!abi) throw rpcError(28, "Class hash not found");
        return { abi };
      }
      if (method === "starknet_call") {
        counters.call++;
        const addr = params.request.contract_address;
        const c = contracts[addr];
        if (!c) throw rpcError(28, "Contract not found");
        const abi = abiOf(addr) ?? [];
        const entry = params.request.entry_point_selector;
        const name = Object.entries({
          supports_interface: "0xfe80f537b66d12a00b6d3c072b44afbb716e78dde5c3f0ef116ee93d3e3283",
          get_implementation: "0x21691762da057c1b71f851f9b709e0c143628acf6e0cbc9735411a65663d747",
        }).find(([, selector]) => selector === entry)?.[0];
        const declared = abi.some((item) => item?.name === name);
        if (!declared) throw rpcError(21, "Entry point not found");
        if (name === "supports_interface") {
          const id = params.request.calldata[0];
          const value = c.supports?.[id];
          if (value === undefined) return ["0x0"];
          return ["0x" + value.toString(16)];
        }
        // get_implementation
        if (c.implementation == null) throw rpcError(1, "Execution reverted");
        return ["0x" + BigInt(c.implementation).toString(16)];
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

async function seed(store, addresses) {
  for (const entry of addresses) {
    const body = collectionRecord({
      chainId: CHAIN_ID,
      address: entry.address,
      state: entry.state ?? "candidate",
      standard: null,
      deployment: { block: 2, hash: HASH(2), transactionIndex: null, eventIndex: null },
      classHistory: [
        {
          classHash: entry.classHash,
          from: { block: 2, hash: HASH(2), transactionIndex: null, eventIndex: null },
          to: entry.open === false ? { block: 4, hash: HASH(4), transactionIndex: null, eventIndex: null } : null,
        },
      ],
      classification: entry.classification ?? null,
      decoderVersion: null,
      replayGeneration: 1,
    });
    store.put("catalog_collection", body.id, body, 1);
  }
  store.put(
    "source_coverage",
    discoveryKey(CHAIN_ID),
    sourceCoverage({
      chainId: CHAIN_ID,
      address: DISCOVERY_ADDRESS,
      sourceType: "discovery",
      mode: "catalog",
      startBlock: 0,
      block: BLOCK,
      hash: HASH(BLOCK),
      observedAt: Date.now(),
      replayGeneration: 1,
      gaps: [],
    }),
    BLOCK,
  );
  store.put("discovery_anchor", String(BLOCK), { block: BLOCK, hash: HASH(BLOCK) }, BLOCK);
}

const record = async (store, addr) =>
  store.get("catalog_collection", collectionKey(CHAIN_ID, addr));

test("an ERC-20 ABI is never accepted as ERC-721 because it emits Transfer", async () => {
  const store = new Store(":memory:");
  const a = C(1);
  await seed(store, [{ address: a, classHash: CLASS(1) }]);
  const rpc = harness({
    contracts: { [a]: { classHash: CLASS(1) } },
    classes: { [CLASS(1)]: ERC20_ABI },
  });
  const result = await classifyOnce(store, rpc, CONFIG);
  assert.equal(result.classified, 1);
  const rec = await record(store, a);
  assert.equal(rec.standard, null, "fungible contracts get no NFT standard");
  assert.equal(rec.state, "unsupported");
  assert.equal(rec.classification.standard, "ERC20", "labeled inside evidence");
  assert.equal(rec.classification.method, "abi");
  assert.ok(
    rec.classification.evidence.some((e) => e.kind === "fungible_markers"),
    "marker evidence retained for investigation",
  );
  assert.equal(rec.classification.eventLayouts.Transfer.data, 3, "event layout recorded");
  await store.close();
});

test("SRC5 ERC-721 support classifies with interface evidence", async () => {
  const store = new Store(":memory:");
  const a = C(2);
  await seed(store, [{ address: a, classHash: CLASS(2) }]);
  const rpc = harness({
    contracts: {
      [a]: { classHash: CLASS(2), supports: { [I.erc721]: 1, [I.isrc5]: 1 } },
    },
    classes: { [CLASS(2)]: ERC721_ABI },
  });
  await classifyOnce(store, rpc, CONFIG);
  const rec = await record(store, a);
  assert.equal(rec.standard, "ERC721");
  assert.equal(rec.state, "candidate");
  assert.equal(rec.classification.method, "src5");
  assert.equal(rec.classification.classHash, CLASS(2));
  assert.equal(
    rec.classification.evidence.find((e) => e.interface === "erc721").supported,
    true,
  );
  assert.deepEqual(rec.classification.eventLayouts.Transfer, { keys: 3, data: 1 });
  assert.deepEqual(rec.classification.aliases.balance_of, ["balance_of"]);
  await store.close();
});

test("legacy ERC165 introspection classifies Cairo 0 collections", async () => {
  const store = new Store(":memory:");
  const a = C(3);
  await seed(store, [{ address: a, classHash: CLASS(3) }]);
  const legacyAbi = [
    { type: "function", name: "supports_interface", inputs: [] },
    { type: "function", name: "owner_of", inputs: [] },
    { type: "function", name: "transfer_from", inputs: [] },
    { type: "event", name: "Transfer", inputs: [{ name: "from" }, { name: "to" }, { name: "id" }] },
  ];
  const rpc = harness({
    contracts: {
      [a]: { classHash: CLASS(3), supports: { [I.erc721Legacy]: 1, [I.erc721]: 0 } },
    },
    classes: { [CLASS(3)]: legacyAbi },
  });
  await classifyOnce(store, rpc, CONFIG);
  const rec = await record(store, a);
  assert.equal(rec.standard, "ERC721");
  assert.equal(rec.classification.method, "erc165_legacy");
  assert.equal(rec.classification.eventLayouts.Transfer.keys, 1, "Cairo 0 layout");
  await store.close();
});

test("class-level ABI evidence is fetched once with address-specific probes", async () => {
  const store = new Store(":memory:");
  const a = C(4),
    b = C(5);
  await seed(store, [
    { address: a, classHash: CLASS(4) },
    { address: b, classHash: CLASS(4) },
  ]);
  const rpc = harness({
    contracts: {
      [a]: { classHash: CLASS(4), supports: { [I.erc721]: 1 } },
      [b]: { classHash: CLASS(4), supports: { [I.erc721]: 0, [I.isrc5]: 1 } },
    },
    classes: { [CLASS(4)]: SHARED_ABI },
  });
  await classifyOnce(store, rpc, CONFIG, { concurrency: 1 });
  assert.equal(rpc.counters.getClass, 1, "one ABI fetch per class, then cached");
  const first = await record(store, a),
    second = await record(store, b);
  assert.equal(first.standard, "ERC721");
  assert.equal(first.classification.method, "src5");
  assert.equal(second.standard, null, "same class, different address result");
  assert.equal(second.state, "unsupported");
  assert.equal(second.classification.uncertainty, "unknown_implementation");
  await store.close();
});

test("proxy implementations are classified with explicit uncertainty", async () => {
  const store = new Store(":memory:");
  const p = C(6),
    impl = address("0x" + 0x999006n.toString(16));
  await seed(store, [{ address: p, classHash: CLASS(6) }]);
  const rpc = harness({
    contracts: {
      [p]: { classHash: CLASS(6), implementation: impl },
      [impl]: { classHash: CLASS(7) },
    },
    classes: { [CLASS(6)]: PROXY_ABI, [CLASS(7)]: IMPL_ABI },
  });
  await classifyOnce(store, rpc, CONFIG);
  const rec = await record(store, p);
  assert.equal(rec.standard, "ERC721");
  assert.equal(rec.classification.method, "proxy_abi");
  assert.equal(rec.classification.uncertainty, "proxy_verified");
  assert.equal(rec.classification.implementation, impl);
  assert.equal(rec.classification.implementationClassHash, CLASS(7));
  await store.close();

  // Unresolvable implementation keeps the identity and the uncertainty.
  const store2 = new Store(":memory:");
  await seed(store2, [{ address: p, classHash: CLASS(6) }]);
  const broken = harness({
    contracts: { [p]: { classHash: CLASS(6), implementation: impl } },
    classes: { [CLASS(6)]: PROXY_ABI },
  });
  await classifyOnce(store2, broken, CONFIG);
  const rec2 = await record(store2, p);
  assert.equal(rec2.standard, null);
  assert.equal(rec2.state, "unsupported");
  assert.equal(rec2.classification.uncertainty, "proxy_unverified");
  assert.equal(rec2.classification.implementation, impl, "identity retained");
  await store2.close();
});

test("an upgrade reopens classification for the new class interval", async () => {
  const store = new Store(":memory:");
  const a = C(8);
  await seed(store, [
    {
      address: a,
      classHash: CLASS(8),
      classification: {
        standard: "ERC721",
        method: "src5",
        classHash: CLASS(8),
        uncertainty: null,
        evidence: [],
        aliases: {},
        eventLayouts: {},
        evidenceBlock: BLOCK,
      },
      state: "candidate",
    },
  ]);
  // Upgrade: the active interval now points at a different class.
  const prior = await record(store, a);
  const upgraded = {
    ...prior,
    classHistory: [
      prior.classHistory[0],
      {
        classHash: CLASS(9),
        from: { block: 4, hash: HASH(4), transactionIndex: null, eventIndex: null },
        to: null,
      },
    ],
  };
  store.put("catalog_collection", upgraded.id, upgraded, 1);
  assert.equal(
    needsClassification(upgraded, BLOCK),
    true,
    "classification pinned to the replaced class is stale",
  );
  const rpc = harness({
    contracts: { [a]: { classHash: CLASS(9), supports: { [I.erc1155]: 1 } } },
    classes: { [CLASS(9)]: ERC721_ABI },
  });
  await classifyOnce(store, rpc, CONFIG);
  const rec = await record(store, a);
  assert.equal(rec.standard, "ERC1155", "reclassified against the new class");
  assert.equal(rec.classification.classHash, CLASS(9));
  await store.close();
});

test("a failed probe isolates one candidate without stopping the batch", async () => {
  const store = new Store(":memory:");
  const bad = C(10),
    good = C(11);
  await seed(store, [
    { address: bad, classHash: CLASS(10) },
    { address: good, classHash: CLASS(11) },
  ]);
  const base = harness({
    contracts: { [good]: { classHash: CLASS(11), supports: { [I.erc721]: 1 } } },
    classes: { [CLASS(11)]: ERC721_ABI },
  });
  const rpc = {
    counters: base.counters,
    call: async (method, params) => {
      if (method === "starknet_getClassHashAt" && params.contract_address === bad)
        throw rpcError(20, "Contract not found");
      return base.call(method, params);
    },
  };
  const result = await classifyOnce(store, rpc, CONFIG);
  assert.equal(result.classified, 1);
  assert.equal(result.failed, 1);
  const failed = await record(store, bad);
  assert.equal(failed.classification.method, "probe_failed");
  assert.equal(failed.classification.attempts, 1);
  assert.equal(failed.state, "candidate", "failures do not change record state");
  assert.equal(await record(store, good).then((r) => r.standard), "ERC721");

  // Bounded retries: attempts exhaust and the candidate is retained, not looped.
  for (let pass = 2; pass <= 3; pass++) {
    const again = await classifyOnce(store, rpc, CONFIG);
    assert.equal(again.failed, 1, `pass ${pass} retries the failure`);
  }
  const settled = await record(store, bad);
  assert.equal(settled.classification.attempts, 3);
  const idle = await classifyOnce(store, rpc, CONFIG);
  assert.equal(idle.skipped, "no_candidates", "exhausted candidate stops retrying");
  await store.close();
});

test("classification commits fail closed when the checkpoint anchor is gone", async () => {
  const store = new Store(":memory:");
  const a = C(12);
  await seed(store, [{ address: a, classHash: CLASS(12) }]);
  // Rewind removed the anchor for the checkpoint; journal has nothing.
  store.put("discovery_anchor", String(BLOCK), { block: BLOCK, hash: "0xdead05" }, 0);
  const rpc = harness({
    contracts: { [a]: { classHash: CLASS(12), supports: { [I.erc721]: 1 } } },
    classes: { [CLASS(12)]: ERC721_ABI },
  });
  await assert.rejects(
    classifyOnce(store, rpc, CONFIG),
    (error) => error.code === "CHAIN_CONFLICT",
  );
  assert.equal((await record(store, a)).classification, null, "nothing committed");
  await store.close();
});

test("ABI summaries and staleness rules are pure and layout-aware", () => {
  const cairo0 = summarizeAbi([
    { type: "event", name: "Transfer", inputs: [{ name: "a" }, { name: "b" }, { name: "c" }] },
    { type: "function", name: "balanceOf" },
  ]);
  assert.deepEqual(cairo0.events[0], { name: "Transfer", keys: 1, data: 3 });
  assert.deepEqual(cairo0.functions, ["balanceOf"]);
  const nested = summarizeAbi([
    { type: "event", name: "pkg::ERC721::Transfer", kind: "enum", variants: [] },
  ]);
  assert.equal(nested.events[0].name, "Transfer");
  assert.equal(nested.events[0].enum, true);

  const fungible = classifyFromEvidence({
    summary: { functions: ["transfer", "decimals", "symbol"], events: [] },
    probes: [],
  });
  assert.equal(fungible.standard, null, "not an NFT standard");
  assert.equal(fungible.classification.standard, "ERC20");
  const patched = classificationPatch({ state: "candidate" }, fungible);
  assert.equal(patched.state, "unsupported", "fungible records are not indexable");
  assert.equal(patched.standard, null, "schema keeps the NFT standard empty");

  const recordBody = {
    classification: { method: "probe_failed", attempts: 2, classHash: CLASS(1) },
    classHistory: [{ classHash: CLASS(1), from: { block: 2 }, to: null }],
  };
  assert.equal(needsClassification(recordBody, 10), true);
  assert.equal(needsClassification({ ...recordBody, classification: { method: "probe_failed", attempts: 3 } }, 10), false);
  assert.equal(
    needsClassification({ ...recordBody, classification: { method: "src5", classHash: CLASS(2) } }, 10),
    true,
    "class mismatch reopens",
  );
  assert.equal(activeClassInterval(recordBody, 10).classHash, CLASS(1));
});
