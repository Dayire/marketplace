import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, selectorFromName } from "../src/starknet-selector.mjs";
import { SELECTORS } from "../src/decode.mjs";

test("Keccak uses its original padding rather than SHA3 padding", () => {
  assert.equal(keccak256(Buffer.from("")), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256(Buffer.from("abc")), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
});

test("owned selector calculation matches every independently frozen repository selector", () => {
  for (const [name, expected] of Object.entries(SELECTORS))
    assert.equal(BigInt(selectorFromName(name)), BigInt(expected), name);
  assert.equal(selectorFromName("__default__"), "0x0");
  assert.equal(selectorFromName("__l1_default__"), "0x0");
  assert.throws(() => selectorFromName(""));
});

test("actual public upgrade, proxy slot and camelCase getter selectors agree", () => {
  assert.equal(selectorFromName("Upgraded"), "0x2db340e6c609371026731f47050d3976552c89b4fbb012941663841c59d1af3");
  assert.equal(selectorFromName("Proxy_implementation_hash"), "0x3f1abe37754ee6ca6d8dfa1036089f78a07ebe8f3b1e336cdbf3274d25becd0");
  assert.equal(selectorFromName("ownerOf"), "0x2962ba17806af798afa6eaf4aa8c93a9fb60a3e305045b6eea33435086cae9");
});
