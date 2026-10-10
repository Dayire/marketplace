-- Reconciliation must also inspect zero balances retained for rollback.
-- Positive-holder API indexes from009 intentionally do not cover these rows.
CREATE INDEX erc1155_balances_reconciliation
  ON market.erc1155_balances(collection,token_id,owner);
