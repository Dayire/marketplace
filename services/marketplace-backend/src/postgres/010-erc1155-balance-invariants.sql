-- Keep migration 8 immutable. Invalid existing evidence fails migration instead
-- of being rounded, silently repaired or discarded.
ALTER TABLE market.erc1155_balances
  ADD COLUMN collection text GENERATED ALWAYS AS (body->>'collection') STORED NOT NULL,
  ADD COLUMN token_id numeric(78,0) GENERATED ALWAYS AS ((body->>'tokenId')::numeric) STORED NOT NULL,
  ADD COLUMN owner text GENERATED ALWAYS AS (body->>'owner') STORED NOT NULL,
  ADD COLUMN balance numeric(78,0) GENERATED ALWAYS AS ((body->>'balance')::numeric) STORED NOT NULL,
  ADD CONSTRAINT erc1155_uint256 CHECK (
    token_id >= 0 AND token_id < 115792089237316195423570985008687907853269984665640564039457584007913129639936 AND
    balance >= 0 AND balance < 115792089237316195423570985008687907853269984665640564039457584007913129639936 AND
    jsonb_typeof(body->'tokenId')='string' AND body->>'tokenId' ~ '^(0|[1-9][0-9]*)$' AND
    jsonb_typeof(body->'balance')='string' AND body->>'balance' ~ '^(0|[1-9][0-9]*)$'
  ),
  ADD CONSTRAINT erc1155_identity CHECK (
    jsonb_typeof(body->'collection')='string' AND collection ~ '^0x[0-9a-f]{64}$' AND
    jsonb_typeof(body->'owner')='string' AND owner ~ '^0x[0-9a-f]{64}$' AND
    collection COLLATE "C" < '0x07ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00' AND
    owner COLLATE "C" < '0x07ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00' AND
    owner <> '0x0000000000000000000000000000000000000000000000000000000000000000' AND
    id = collection || ':' || (body->>'tokenId') || ':' || owner
  ),
  ADD CONSTRAINT erc1155_native_felts CHECK (
    body ? 'balanceFelts' AND jsonb_typeof(body->'balanceFelts')='array' AND
    jsonb_array_length(body->'balanceFelts')=2 AND
    jsonb_typeof(body->'balanceFelts'->0)='string' AND
    jsonb_typeof(body->'balanceFelts'->1)='string' AND
    body->'balanceFelts'->>0 ~ '^0x(0|[1-9a-f][0-9a-f]{0,31})$' AND
    body->'balanceFelts'->>1 ~ '^0x(0|[1-9a-f][0-9a-f]{0,31})$'
  ),
  ADD CONSTRAINT erc1155_owner_token UNIQUE (collection,token_id,owner);
CREATE INDEX erc1155_balances_owner ON market.erc1155_balances(owner,collection,token_id,id) WHERE balance>0;
CREATE INDEX erc1155_balances_collection ON market.erc1155_balances(collection,token_id,owner,id) WHERE balance>0;
