-- STEP 11 of the fashion-retail evolution: a per-variant reorder threshold. Null means "no
-- alert configured for this variant" -- inventory.html only flags a variant once someone
-- has actually set a threshold for it, rather than guessing a default that might be wrong
-- for a slow-moving vs. fast-moving product.
alter table product_variants add column reorder_threshold integer check (reorder_threshold >= 0);
