-- Additive: bounded per-collection backfill jobs with pinned anchors (#113).
CREATE TABLE chain.backfill_jobs(
 id text PRIMARY KEY,
 body jsonb NOT NULL,
 CHECK(body ?& ARRAY['id','chainId','collection','from','target','state'])
);
