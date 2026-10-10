import { test } from "node:test";
import assert from "node:assert/strict";
import { indexerOptions, discoveryOptions } from "../src/indexer-options.mjs";
test("index throughput controls are bounded and environment overrides are explicit", () => {
  assert.deepEqual(indexerOptions({}), {
    fastHistory: false,
    historyWindow: 100000,
    window: 1000,
    receiptConcurrency: 8,
    receiptBatchSize: 1,
    commitBatchSize: 250,
  });
  assert.equal(
    indexerOptions({ MARKETPLACE_INDEX_CONCURRENCY: "8" }).receiptConcurrency,
    8,
  );
  for (const value of ["0", "10000", "1.5", "NaN"])
    assert.throws(() =>
      indexerOptions({ MARKETPLACE_INDEX_CONCURRENCY: value }),
    );
});

test("discovery controls are bounded with explicit defaults", () => {
  assert.deepEqual(discoveryOptions({}), {
    span: 100,
    concurrency: 4,
    emitters: true,
    emitterBudget: 2000,
    probes: 6,
    earliest: 0,
    maxRewind: 100,
  });
  assert.equal(
    discoveryOptions({ MARKETPLACE_DISCOVERY_EMITTERS: "false" }).emitters,
    false,
  );
  assert.equal(
    discoveryOptions({ MARKETPLACE_DISCOVERY_SPAN: "2000" }).span,
    2000,
  );
  assert.equal(
    discoveryOptions({ MARKETPLACE_DISCOVERY_EARLIEST: "123456" }).earliest,
    123456,
  );
  for (const value of ["0", "2001", "1.5", "NaN"])
    assert.throws(() => discoveryOptions({ MARKETPLACE_DISCOVERY_SPAN: value }));
  for (const value of ["0", "33", "-1"])
    assert.throws(() =>
      discoveryOptions({ MARKETPLACE_DISCOVERY_CONCURRENCY: value }),
    );
  assert.throws(() => discoveryOptions({ MARKETPLACE_DISCOVERY_PROBES: "17" }));
  assert.throws(() =>
    discoveryOptions({ MARKETPLACE_DISCOVERY_MAX_REWIND: "10001" }),
  );
});
