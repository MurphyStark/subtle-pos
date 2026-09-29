# Subtle POS

Offline-first POS + inventory system for Subtle Accessories (Zimbabwe). Two stock
locations: the **shop** everyone sells from, and a **Warehouse** that only the **owner** can
see or touch (`20260901091900_warehouse_location.sql` — restrictive RLS on every
location-keyed table plus a filtered `v_inventory_balances`; the demo mock mirrors it). The
original "Home / Wholesale Store" second location was removed earlier (see below);
wholesale as a *pricing tier* is unaffected. Stock moves between shop and Warehouse on the
owner-only `transfers.html`. The product catalog in `web/js/mockClient.js` is generated
from the stock tracker workbook (`../Subtle Accessories Stock Tracker.xlsx`). Source spec: `../subtle pos prd v2 and build
prompt.md` (a PRD-addendum + VS Code build prompt — not the full original PRD; see the gap
noted below).

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
- **Purchase order receiving deliberately reuses `stock_receipts`/`stock_receipt_items`**
  rather than giving POs their own stock/cost logic — `purchase_orders.id` is just
  traceability on the receipt. `quantity_received`/status on the PO itself are updated by
  the app after each receipt, not a DB trigger, since that's workflow status, not financial
  history like the receipt itself is.
- **`sale_item_returns.refund_method` records `'store_credit'` as a choice, not a ledger** —
  there's no running credit balance or redemption at checkout. Building that is its own
  feature once it's actually needed.
- **Receipt sharing favors zero-infrastructure options**: WhatsApp via a `wa.me` text link,
  email via `mailto:`, both because there's no backend email/messaging service to call.
  Thermal printing (`web/js/thermal-print.js`) uses WebUSB + ESC/POS and is **untested
  against real hardware** — no printer was available to verify against; the byte sequence
  follows the spec, but a specific printer model may need endpoint/vendor adjustments.
- **The second stock location was removed entirely, not just hidden.** The user was asked
  explicitly (destructive/hard-to-reverse change) and chose to collapse to one location
  rather than keep it dormant. `20260901091500_remove_wholesale_location.sql` merges the
  wholesale location's stock into the shop location (same weighted-average-cost blend used
  everywhere else in this schema), reassigns any `user_profiles.primary_location_id`
  pointing at it, then deletes the location row. It assumes no real Supabase project has
  ever taken live transactional data (documented in the migration itself) — a deployment
  with real sales/receipts/counts/POs already referencing that location would hit FK
  violations on the final `delete`, and would need a manual data migration first, not just
  this script.
- **Manager PIN approval returns an id, not a boolean.** `verify_manager_pin(p_pin)` returns
  the approving manager/owner's `uuid` (or `null`), never the PIN itself or a plain
  true/false — a boolean couldn't record *which* manager approved a discount, and the RPC
  needs to work for a cashier's device that structurally cannot read `user_profiles.manager_pin`
  directly (same masking philosophy as `unit_cost_at_sale_cents` above). A partial unique
  index (`where manager_pin is not null`) stops two managers from ever sharing one PIN.
- **Discount codes are global**, not per-location or per-product — `discount_codes` has no
  location/product scoping columns. Revisit if per-product promotions are needed later; the
  table's shape would need to change, not just its data.

## Layout

```text
supabase/
  migrations/     -- apply in filename order (already Supabase CLI-compatible naming)
  tests/
    immutability_test.sql   -- verifies changing a product's cost never changes a past sale's profit
web/
  index.html, pos.html, ...  -- plain multi-page frontend (see web/README.md for exactly what each page does)
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

The 11-step fashion-retail evolution (size/color variants, purchase orders, returns,
promotions, reporting, low-stock alerts) is **now complete** — see `web/README.md`'s
"Fashion-retail evolution" section for exactly what each step does and doesn't cover. The
final batch (steps 9–11) also bundled five additional requirements from the same request:
a full Reports & Analytics page (`reports.html`), removal of the second stock location
(wholesale as a *pricing tier* is unaffected — see the judgment-calls section above),
offline support extended to stock takes and returns (checkout already had it), an Excel
(`.xlsx`) export of the core tables for backup/analysis, and staff presence + a full
activity log (`activity.html`). See `web/README.md` for the details and scope notes on each.

Two pre-existing bugs were found and fixed while building this batch (not introduced by it,
but blocking correct behavior for reporting and returns) — see `web/README.md`'s "Bugs found
and fixed this pass" section: `product_prices`/`product_cost_history` inserts colliding
under the demo mock's dedup logic (silently dropping a second product's price/cost), and
`v_sale_items` never being wired up in the mock at all (returns always saw an empty list,
and no line ever carried COGS/profit).
