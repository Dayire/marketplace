-- Inline NFT artwork can exceed PostgreSQL's btree tuple limit. Index a bounded
-- digest; queries also compare the full URI, so digest collisions cannot reuse
-- another source's artwork.
DROP INDEX IF EXISTS market.token_metadata_image_source;
CREATE INDEX token_metadata_image_source_hash ON market.token_metadata
  (md5(body->'metadata'->>'imageSourceUri'))
  WHERE body->>'image' IS NOT NULL;
