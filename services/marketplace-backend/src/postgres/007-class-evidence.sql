-- Additive: immutable per-class ABI summaries reused across address probes (#111).
-- Class hash identifies code, so rows are a rebuildable cache with no heights.
CREATE TABLE chain.class_evidence(
 id text PRIMARY KEY,
 body jsonb NOT NULL,
 CHECK(id ~ '^0x[0-9a-f]+$'),
 CHECK(body ?& ARRAY['classHash','functions','events'])
);
