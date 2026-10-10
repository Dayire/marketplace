-- Additive: ERC-1155 per-(collection, token, owner) balances (#117).
CREATE TABLE market.erc1155_balances(
  id text PRIMARY KEY,
  body jsonb NOT NULL,
  CHECK(body ? 'collection' AND body ? 'tokenId' AND body ? 'owner' AND body ? 'balance')
);
