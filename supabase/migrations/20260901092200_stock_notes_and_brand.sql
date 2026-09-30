-- Redesign phase 2 fields:
--   * notes on a stock count and on each counted line ("Slightly damaged box", "Found 1
--     extra unit") -- shown on the stock take review, details and report pages;
--   * notes on a stock receipt, for stock added by hand from the variant page;
--   * a product brand (Stanley, Owala, Gucci...) for the product and variant pages.
-- All nullable, so existing rows and older clients are unaffected.
alter table stock_counts add column notes text;
alter table stock_count_items add column notes text;
alter table stock_receipts add column notes text;
alter table products add column brand text;
