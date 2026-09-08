# Subtle POS

Offline-first POS + inventory system for Subtle Accessories (Zimbabwe, two stock
locations). Source spec: `../subtle pos prd v2 and build prompt.md` (a PRD-addendum + VS
Code build prompt — not the full original PRD; see the gap noted below).

## Stack deviation from the build prompt

The build prompt specifies a React + TypeScript PWA frontend. **This project instead uses
plain multi-page HTML + vanilla JS** (`web/`), by explicit user choice, matching the style
of this agency's other client sites. The database/RLS layer is unaffected either way — this
only changes `web/`, not `supabase/`. Offline support (IndexedDB outbox + background sync)
is hand-rolled in `web/js/db.js` / `web/js/sync.js` rather than coming from a framework's
PWA plugin.

## Gap you should know about

The original PRD's full **Section 18 table list** was never provided when this schema was
written — only the "PRD v2" addendum (business-logic review) and the build prompt, which
describe the rules in prose but don't reproduce Section 18's literal field list. The schema
was reconstructed from that prose plus standard POS domain modeling.

**Before treating this as final, diff it against the actual PRD Section 18** for exact
table/field-name parity. Places most likely to drift from the source document:
- Exact column names Section 18 may have specified for `products`, `sales`, etc.
- Whether Section 18 defines additional tables not implied by the addendum's prose.
- Section 19's exact permission matrix per role (this schema's RLS makes reasonable
  judgment calls — e.g., letting cashiers request-but-not-approve transfers, letting any
  role process a return — that should be checked against the real spec).

## Judgment calls made beyond the explicit prompt

- **`sale_payments`** table added (not in the addendum) — needed for split/multi-currency
  tender on one sale, which section 1.3's "settles in more than one currency" implies but
  doesn't spec a table for.
- **`stock_receipt_items` made append-only** (no update/delete), matching the same
  financial-integrity logic as `sale_items` — a bad receipt is corrected with a new
  offsetting receipt, never an edit, since receipts drive `average_unit_cost_cents`.
- **`unit_cost_at_sale_cents` is populated server-side by a trigger
  (`fn_populate_sale_item_cost_snapshot`), never supplied by the client.** The build prompt
  originally implied the client copies both price and cost in at insert time, but RLS makes
  cost unreadable to a cashier's device — it structurally cannot know the value to send. The
  trigger looks up `product_cost_history` as of the *sale's own `created_at`* (the moment
  the sale actually happened, not when it happened to sync), so it still satisfies "snapshot
  at the moment of sale" for sales replayed later from the offline queue. A product with no
  cost history yet cannot be sold — there's no cost basis to snapshot. `unit_selling_price_cents`
  is still client-supplied, since a cashier is allowed to know the selling price.
- **Column-level cost/profit masking implemented via views** (`v_sale_items`,
  `v_inventory_balances`, `v_sale_item_returns`), not plain `GRANT`/`REVOKE`. Supabase gives
  every logged-in user the same Postgres role (`authenticated`) regardless of app role, so
  static column privileges can't tell a cashier from a manager — only a role-aware `CASE`
  inside a view can. **All application/reporting code must query these views, never the
  three underlying base tables directly** (base-table `SELECT` is revoked from
  `authenticated` on purpose — see the comment block at the top of
  `20260901090800_rls_policies.sql`).
- Base currency assumed **USD** for `currency_rates.rate_to_base`. Revisit if that's wrong.
- **Product photos go through Supabase Storage's `product-images` bucket** (public read,
  manager/owner write — created directly in `20260901090900_admin_and_stock_take.sql` via
  `storage.buckets`, no manual dashboard step needed), with `products.image_url` storing the
  resulting public URL. Images are resized/compressed client-side to ~900px/JPEG before
  upload (`web/js/image.js`) regardless of backend, since a raw phone photo is overkill for
  a product thumbnail.
- **Stock take reconciliation sets quantity to exactly what was counted**, not an adjustment
  layered on top (`fn_apply_stock_count_completion`) — a physical count is treated as ground
  truth. It also clears `needs_review`, since a fresh count supersedes whatever raised it.
- **`product_variants` (size/color/SKU/barcode/stock) keeps price and cost at the product
  level**, shared across all of a product's variants — only identity and physical stock
  move down to the variant. See `20260901091000_product_variants.sql`'s header comment.

## Layout

```text
supabase/
  migrations/     -- apply in filename order (already Supabase CLI-compatible naming)
  tests/
    immutability_test.sql   -- verifies changing a product's cost never changes a past sale's profit
web/
  index.html, pos.html, ...  -- plain multi-page frontend (see web/README.md once it exists)
```

## Applying the schema

No Supabase project exists yet for Subtle POS. To stand this up:

1. `supabase init` in this directory (or point an existing `supabase/` config at these
   migration files).
2. `supabase link` to a project, or create a new one.
3. `supabase db push` (or `psql -f` each migration file in order) to apply the schema.
4. `psql "$DATABASE_URL" -f supabase/tests/immutability_test.sql` to verify the core
   invariant holds.
5. Fill in `web/js/config.js` with the project's URL and anon key.

## What's next

The project is now also mid-way through an 11-step fashion-retail evolution (size/color
variants, purchase orders, returns, promotions, reporting, low-stock alerts) reviewed one
step at a time — see `web/README.md`'s "Fashion-retail evolution" section for exact status.
Steps 1 (data model), 2 (admin: product + variant creation), 3 (barcode labels), and 4
(checkout: variant picker + exact-barcode-scan resolution) are all done — `web/pos.html` is
fully working again. Still ahead: purchase orders/transfers, returns, customers,
promotions, reporting, and low-stock alerts (steps 5–11).
