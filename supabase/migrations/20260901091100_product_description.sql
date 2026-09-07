-- STEP 2 (admin) prerequisite: the parent-product form now captures a description
-- alongside name/currency/pricing.
alter table products add column description text;
