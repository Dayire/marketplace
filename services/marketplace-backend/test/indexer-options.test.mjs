import { test } from "node:test";
import assert from "node:assert/strict";
import { indexerOptions, discoveryOptions, catalogOptions } from "../src/indexer-options.mjs";
test("index throughput controls are bounded and environment overrides are explicit", () => {
  assert.deepEqual(indexerOptions({}), {
    fastHistory: false,
    historyWindow: 100000,
    window: 1000,
    receiptConcurrency: 8,
    receiptBatchSize: 1,
    commitBatchSize: 250,
    maxWindowEvents: 50000,
    emitterBudget: 500,
  });
  assert.equal(
    indexerOptions({ MARKETPLACE_INDEX_CONCURRENCY: "8" }).receiptConcurrency,
    8,
  );
  for (const value of ["0", "10000", "1.5", "NaN"])
    assert.throws(() =>
      indexerOptions({ MARKETPLACE_INDEX_CONCURRENCY: value }),
    );
  assert.equal(
    indexerOptions({ MARKETPLACE_INDEX_WINDOW_EVENT_BUDGET: "1000" })
      .maxWindowEvents,
    1000,
    "acquisition budgets are environment configurable",
  );
  assert.equal(
    indexerOptions({ MARKETPLACE_INDEX_EMITTER_BUDGET: "42" }).emitterBudget,
    42,
  );
  for (const value of ["10", "2000000", "1.5"])
    assert.throws(() =>
      indexerOptions({ MARKETPLACE_INDEX_WINDOW_EVENT_BUDGET: value }),
    );
});

test('catalog cycles have independently bounded live, enrichment and backfill budgets', () => {
  const options = catalogOptions({});
  assert.equal(options.live.window, 16);
  assert.equal(options.live.fastHistory, false);
  assert.equal(options.discovery.span, 16);
  assert.equal(options.discovery.emitters, false);
  assert.equal(options.backfill.window, 4);
  assert.equal(options.queueLimit, 8);
  assert.equal(options.classify.limit, 8);
  assert.equal(catalogOptions({ MARKETPLACE_CATALOG_BACKFILL_WINDOW: '32' }).backfill.window, 32);
  for (const bad of ['0', '1001', '1.1', 'NaN'])
    assert.throws(() => catalogOptions({ MARKETPLACE_CATALOG_BACKFILL_WINDOW: bad }));
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
