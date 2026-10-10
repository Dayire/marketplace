-- Additive: chain evidence never overwrites registered metadata or durable policy.
CREATE TABLE chain.collection_catalog(
 id text PRIMARY KEY,
 body jsonb NOT NULL,
 chain_id text GENERATED ALWAYS AS (body->>'chainId') STORED NOT NULL,
 address text GENERATED ALWAYS AS (body->>'address') STORED NOT NULL,
 state text GENERATED ALWAYS AS (body->>'state') STORED NOT NULL,
 standard text GENERATED ALWAYS AS (body->>'standard') STORED,
 replay_generation bigint GENERATED ALWAYS AS ((body->>'replayGeneration')::bigint) STORED NOT NULL,
 CHECK(id=chain_id || ':' || address),
 CHECK(chain_id ~ '^0x(0|[1-9a-f][0-9a-f]*)$'),
 CHECK(address ~ '^0x[0-9a-f]{64}$'),
 CHECK(state IN ('unknown','candidate','syncing','indexed','unsupported','failed')),
 CHECK(standard IS NULL OR standard IN ('ERC721','ERC1155')),
 CHECK(replay_generation BETWEEN 1 AND 9007199254740991),
 CHECK(body ?& ARRAY['id','chainId','address','state','standard','deployment','classHistory','classification','decoderVersion','replayGeneration']),
 CHECK(NOT (body ?| ARRAY['visible','verified','tradable'])),
 CHECK(jsonb_typeof(body->'classHistory')='array'),
 CHECK(jsonb_array_length(body->'classHistory')<=128),
 UNIQUE(chain_id,address)
);
CREATE INDEX collection_catalog_state ON chain.collection_catalog(chain_id,state,id);
CREATE TABLE chain.source_coverage(
 id text PRIMARY KEY,
 body jsonb NOT NULL,
 chain_id text GENERATED ALWAYS AS (body->>'chainId') STORED NOT NULL,
 address text GENERATED ALWAYS AS (body->>'address') STORED NOT NULL,
 replay_generation bigint GENERATED ALWAYS AS ((body->>'replayGeneration')::bigint) STORED NOT NULL,
 start_block bigint GENERATED ALWAYS AS ((body->>'startBlock')::bigint) STORED,
 block_number bigint GENERATED ALWAYS AS ((body->>'block')::bigint) STORED,
 block_hash text GENERATED ALWAYS AS (body->>'hash') STORED,
 CHECK(id=chain_id || ':' || address),
 CHECK(chain_id ~ '^0x(0|[1-9a-f][0-9a-f]*)$'),
 CHECK(address ~ '^0x[0-9a-f]{64}$'),
 CHECK(replay_generation BETWEEN 1 AND 9007199254740991),
 CHECK(body ?& ARRAY['id','chainId','address','sourceType','mode','startBlock','block','hash','observedAt','replayGeneration','gaps']),
 CHECK(start_block IS NULL OR start_block BETWEEN 0 AND 9007199254740991),
 CHECK(block_number IS NULL OR block_number BETWEEN 0 AND 9007199254740991),
 CHECK((block_number IS NULL)=(block_hash IS NULL)),
 CHECK(block_hash IS NULL OR block_hash ~ '^0x(0|[1-9a-f][0-9a-f]*)$'),
 CHECK(start_block IS NULL OR block_number IS NULL OR start_block<=block_number),
 CHECK(jsonb_typeof(body->'gaps')='array'),
 CHECK(jsonb_array_length(body->'gaps')<=100),
 CHECK(body->>'sourceType' IN ('nft','marketplace','discovery')),
 CHECK(body->>'mode' IN ('catalog','configured_scan')),
 UNIQUE(chain_id,address)
);
CREATE INDEX source_coverage_checkpoint ON chain.source_coverage(chain_id,replay_generation,block_number);
