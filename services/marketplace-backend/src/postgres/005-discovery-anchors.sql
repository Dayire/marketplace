-- Additive: per-block discovery walk anchors prove deployment/upgrade provenance
-- and bound reorg rewinds to the highest block whose hash still matches the chain.
CREATE TABLE chain.discovery_anchors(
 id text PRIMARY KEY,
 body jsonb NOT NULL,
 number bigint GENERATED ALWAYS AS ((body->>'block')::bigint) STORED NOT NULL,
 hash text GENERATED ALWAYS AS ((body->>'hash')) STORED NOT NULL,
 CHECK(id = (body->>'block')),
 CHECK(number >= 0),
 CHECK(hash ~ '^0x[0-9a-f]+$'),
 CHECK(body ?& ARRAY['block','hash'])
);
CREATE INDEX discovery_anchors_block ON chain.discovery_anchors(number DESC);
