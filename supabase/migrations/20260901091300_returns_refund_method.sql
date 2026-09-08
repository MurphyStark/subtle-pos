-- STEP 6 of the fashion-retail evolution: returns UI needs one new field on the
-- already-existing sale_item_returns table (reason, refund_amount_cents, processed_by,
-- and the COGS/gross-profit reversal logic all already exist from the original schema).
--
-- SCOPE NOTE: this records which refund method was used, including 'store_credit', but
-- does NOT implement a store-credit ledger/balance or redemption at checkout -- that would
-- be its own feature (tracking a running balance per customer, redeeming it against a
-- future sale). Recording the choice here is honest bookkeeping of what happened at the
-- counter; building the ledger is future work once customer accounts (step 8) exist.
alter table sale_item_returns
  add column refund_method text not null default 'cash'
  check (refund_method in ('cash', 'card', 'store_credit', 'other'));
