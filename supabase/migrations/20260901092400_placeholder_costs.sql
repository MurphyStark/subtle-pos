-- A product can't be sold without a cost basis (fn_populate_sale_item_cost_snapshot), so a
-- catalog imported before real cost prices are known gets a stand-in cost row. Without a
-- flag, that stand-in is indistinguishable from a real cost: average cost showed as the
-- selling price and every margin read as zero.
--
-- is_placeholder marks those stand-in rows. The UI shows the cost as "Not set" and leaves
-- sales made at a placeholder cost out of profit figures. Entering a real cost appends a
-- normal row (is_placeholder = false), as any cost change does.
alter table product_cost_history add column is_placeholder boolean not null default false;

comment on column product_cost_history.is_placeholder is
  'True for a stand-in cost added only so a product can be sold before its real cost is known. '
  'Reports exclude sales costed at a placeholder from profit; the UI shows the cost as not set.';
