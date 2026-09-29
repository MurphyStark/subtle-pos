# Subtle POS — web (plain HTML/JS frontend)

No build step, no bundler, no framework — matches the rest of this agency's client sites.
Supabase's JS SDK loads from a CDN `<script>` tag as a UMD global; every page's own logic
is a native ES module (`<script type="module">`) that imports from `js/`.

## Running it locally

ES modules and the service worker both require a real HTTP origin — opening `index.html`
directly as a `file://` URL will not work. From this `web/` directory:

```text
python3 -m http.server 8080
# or: npx serve .
```

Then open `http://localhost:8080`.

## Fashion-retail evolution (in progress)

This project is mid-way through an 11-step plan to evolve from a flat-SKU accessories POS
into a variant-aware fashion retail system (size/color, purchase orders, returns,
promotions, reporting, etc.) — each step is its own migration + UI change, reviewed
individually. Current status:

- ✅ **Step 1** (data model): `product_variants` table; `sku`/`barcode`/physical stock moved
  off `products` onto variants. Price and cost stay at the product level, shared across
  variants — see `20260901091000_product_variants.sql`'s header comment for the reasoning.
- ✅ **Step 2** (admin): `admin.html` reworked into parent-product creation (name,
  description, currency, price, cost, photo) + adding variants (size, color, barcode,
  SKU, initial qty/location) under it, including to an already-existing product.
  `inventory.html` and `stock-take.html` were updated alongside it (not a numbered step of
  their own, but a direct consequence of the data model change they both depend on).
- ✅ **Step 3** (barcode labels): a "Print label" button per variant and "Print all labels
  for this product" per product on `admin.html`, rendering a CODE128 barcode (via the
  JsBarcode CDN script) plus product name, size/color, SKU, and retail price, sized for a
  standard 50mm×25mm label printer. Printed via the browser's native print dialog (which
  itself offers "Save as PDF" as a destination) rather than a PDF-generation library — same
  approach as the checkout receipt. A variant with no barcode on file falls back to
  encoding its SKU. **No migration needed for this step** — it's a pure rendering feature
  over data `admin.html` already has, nothing new to persist.
- ✅ **Step 4** (checkout): `pos.html` reworked for variants. Tapping a product with exactly
  one variant adds it straight to the cart (the common case for a product with no real
  size/color variation); tapping one with more than one opens a picker showing each
  size/color option (with a live stock count per option). The search box still filters the
  grid as you type, and now also matches on any variant's SKU/barcode; pressing **Enter**
  with the box containing an exact variant barcode or SKU resolves straight to that variant
  and adds it — the same behavior a USB/Bluetooth barcode scanner produces (it types the
  code, then sends an Enter keystroke), so a plug-in scanner works with zero extra
  integration. The offline cache (`js/db.js`) now stores variants alongside products so
  this all still works with no connection. `js/receipt.js` shows each line's size/color
  alongside the product name.
- ✅ **Step 5** (purchase orders & transfers): `purchase-orders.html` raises a PO against a
  supplier (per-variant lines: quantity + expected cost), then "Record receipt" against it
  creates a real `stock_receipts`/`stock_receipt_items` row (the exact mechanism admin.js
  already uses) rather than duplicating stock/cost logic — this correctly recomputes
  weighted-average cost via the existing trigger. Partial receipts are supported; the PO's
  own status (`sent` → `partially_received` → `received`) is recalculated by the app after
  each receipt, not by a database trigger, since that's workflow status, not financial
  history. `transfers.html` originally covered the "simple" stock-transfer flow between the
  two locations — **removed** in the steps 9–11 batch when the second location was collapsed
  into one (see the top-level README's judgment-calls section); with only one location left,
  a transfer has no destination to move stock to.
  **Restored (Sep 2026)** as an owner-only page for moving stock between the shop and the
  new Warehouse location; a move goes straight to `received` since the owner is both
  requester and approver.
- ✅ **Step 6** (returns): `returns.html` searches past sales by receipt number, date range,
  or customer name/phone, then lets you select a returnable line, capture a reason (wrong
  size, defect, changed mind, other) and a refund method (cash, card, or store credit), and
  processes it — reversing COGS/gross profit using the *original* recorded unit cost (never
  today's), restocking the correct variant at the original sale's location, and logging the
  acting user, all via the `sale_item_returns` mechanism that already existed in the schema
  from the very first migration. Over-returning beyond what was actually sold is rejected.
  **Scope note:** "store credit" as a refund method is recorded, but there's no credit
  ledger/balance or redemption at checkout — that would be its own feature.
- ⏳ **Step 7** (receipts) — itemized/taxes/payment/cashier/timestamp already existed. Added:
  a "WhatsApp" button (a `wa.me` link pre-filled with a plain-text receipt — this is the
  offline-friendly default, since building the link needs no network, only actually sending
  it does), an "Email" button (`mailto:` with the receipt as the body — there's no backend
  email service here, so a person still has to hit send), and, where the browser supports it
  (`js/thermal-print.js`, desktop Chrome/Edge or Android Chrome only — not Safari or
  Firefox), a "Thermal print" button using WebUSB + ESC/POS commands. **The thermal path is
  UNTESTED against real hardware** — no printer was available in this environment; the
  command bytes follow the ESC/POS spec but a specific printer may need adjustment.
- ✅ **Step 8** (customers): a lightweight `customers` table (name, phone, optional email).
  `pos.html` gained optional name/phone fields at checkout that find-or-create a customer by
  phone (so ringing up the same regular twice doesn't create two records) and attach
  `customer_id` to the sale; leaving both blank keeps checkout exactly as it was before this
  step (an anonymous sale). `customers.html` lists/searches customers and shows each one's
  purchase history.
- ✅ **Step 9** (promotions): `discount_codes` (percentage or fixed amount, optional min
  spend, optional expiry, active toggle) managed from `admin.html`. At checkout, `pos.html`
  splits "discount" into a **discount code** (looked up and validated live against the code's
  active/date/min-spend rules — requires connectivity, since a stale/offline code check could
  apply an expired or deactivated code) and a **manual discount**, which above a configurable
  cap (`app_settings.manual_discount_cap_cents`, default $20, editable only via direct DB/API
  access right now — no settings UI for it yet) requires a manager's PIN, verified via
  `verify_manager_pin()` so the approving manager's identity (never the PIN itself) is
  recorded on the sale (`sales.discount_approved_by`). Managers/owner set their own PIN from
  a self-service form on `admin.html` (never someone else's — there's no "set another user's
  PIN" UI, deliberately).
- ✅ **Step 10** (reporting) plus the request's expanded Reports & Analytics ask:
  `reports.html` (manager/owner only) covers total sales, total profit, and transactions for
  a date range (with Today/This week/This month presets); a daily/weekly/monthly sales-over-
  time table; a product-performance table (units/revenue/profit/margin, best sellers first);
  a monthly detail table broken down per product; and a Z-report (cash-drawer reconciliation
  by payment method for a single day, net of that day's refunds). **Every aggregate is
  grouped by currency**, never summed across USD/ZWG/ZAR, since a blended total across
  currencies would be meaningless. An "Export to Excel" button on the same page produces a
  genuine multi-sheet `.xlsx` (Sales, Sale Items, Products, Variants, Customers) via the
  SheetJS CDN library, covering the raw requirement for "data export, backup, reporting, and
  analysis" beyond just the on-screen aggregates. Reports are **online-only by design** — they
  need a complete, current view of sales history, not a possibly-stale local cache, so
  there's no offline fallback here (unlike checkout/stock-take/returns).
- ✅ **Step 11** (low-stock alerts): `product_variants.reorder_threshold` (optional, set per
  variant in `admin.html`). `inventory.html` flags any variant at or below its threshold with
  a ⚠ badge, a "Show low-stock only" filter, and a "Reorder" link that opens
  `purchase-orders.html?variant=<id>` with that variant pre-selected in the new-PO form — a
  variant with no threshold set never flags (no threshold means "not tracked for reordering",
  not "always fine").
- The same batch also added **presence + a full activity log**
  (`activity.html`/`js/activity.js`), not one of the original 11 steps but part of the same
  request: a heartbeat (`user_profiles.last_seen_at`, updated every 60s from every
  authenticated page via `nav.js`) drives a "who's online" list (seen in the last 2 minutes =
  online); an append-only `activity_log` table records logins, logouts, sales, stock changes
  (variant creation, stock takes, PO receipts), product/price edits, refunds, discount-code
  changes, manual-discount approvals, and customer creation, each with the acting user and
  timestamp, filterable by user/action/date range on the same page.

## Demo mode

`js/config.js` currently still has its placeholder Supabase URL. Rather than that meaning
nothing works, `js/supabaseClient.js` detects the placeholder and automatically swaps in
`js/mockClient.js` — a stand-in that implements exactly the subset of the Supabase API this
app calls (including `.storage.*` and the `verify_manager_pin` RPC), backed by the **real
Subtle Accessories product catalog** (`web/Catalog/Subtle Accessories Product Catalog.xlsx`
— 17 products, 49 color/style variants, real names/SKUs/prices; brand colors are black and
gold, reflected in `css/style.css`), one stock location, and four demo accounts — one per
role, two of them pre-seeded with a manager PIN — persisted to `localStorage`. The login page
shows one-click sign-in buttons for each role plus a "Reset demo data" button. Selling
something in checkout visibly decrements stock on the Inventory page, adding a product in
Admin (photo included — stored as a data URL in `localStorage` standing in for a real
Storage bucket) shows up immediately, and completing a stock take reconciles the count —
all the same as the real thing would.

**Two fields the catalog itself flags as incomplete** ("fill in before syncing", per its own
legend) are seeded as explicit placeholders, not estimates, per direct instruction: **cost
price is seeded equal to retail price** (zero margin — every gross-profit figure on
`reports.html` will read $0 until real costs are entered per product via `admin.html`'s
price-edit row), and **stock quantity is seeded at 0** for every variant (every product is
sellable — it has a price and a cost basis — but shows no stock until stock is actually
received). Barcodes are also blank in the catalog and left unset (labels fall back to
printing the SKU instead, same as any product with no barcode).

**This is a real dependency, not a toy — it's what makes the deployed site demoable before
a Supabase project exists.** Swap-out is automatic: once `js/config.js` has a real project
URL + anon key (see `../README.md`), demo mode turns itself off and every page talks to the
real Supabase project instead. No other file needs to change. At that point you'll also
need to create at least one real `auth.users` + matching `user_profiles` row to sign in
with (Supabase Studio's Authentication tab, or `supabase auth` CLI, then insert the
`user_profiles` row by hand for now — there's no admin UI for that yet, see below).

## What's actually built in this pass

- **`index.html`** — login (Supabase email/password auth).
- **`pos.html`** — full checkout flow, variant-aware (see step 4 above): a product grid,
  always at retail price (the Retail/Wholesale toggle was removed — every sale is
  `sale_type: 'retail'` now; wholesale as a *pricing tier* on a product is untouched and
  still editable in `admin.html`, there's just no way to sell at that price from the till
  any more), where a multi-variant product opens a size/color picker and a single-variant
  one adds straight to cart; a
  search box that resolves an exact barcode/SKU scan directly to its variant on Enter;
  cart, discount/tax entry, one payment method per sale; the offline path (queued in
  IndexedDB — now caching variants alongside products — replayed automatically once
  connectivity returns via `js/db.js` + `js/sync.js`); and a printable Subtle Accessories
  receipt (`js/receipt.js`, showing each line's size/color) with a "Print" button
  (`window.print()` + `@media print` rules that hide everything but the receipt — works
  with any regular printer; thermal receipt printer integration is hardware-specific
  follow-up work, not built here). Responsive down to phone width — this is the page meant
  to run on a laptop, tablet, or phone at checkout.
- **`inventory.html`** — read-only stock levels **per variant** per location, manager/owner
  only (cost column comes from `v_inventory_balances`, which the database itself nulls out
  for anyone else). Shows product name, size/color, SKU, location, quantity, and cost.
- **`admin.html`** — manager/owner only, reworked for variants. Create a **parent product**
  first (name, description, currency, retail/wholesale price, minimum wholesale quantity,
  cost price, photo) — no SKU or stock at this stage, since those now belong to variants and
  a product isn't sellable until it has at least one. Then, per product, **add one or more
  variants** (size, color, SKU — auto-suggested from the product name but editable,
  barcode, initial quantity + location); variants can be added to an already-existing
  product at any time, not just at creation. A variant with initial stock creates a proper
  stock receipt (landed cost pulled from the product's existing cost basis, since cost is
  entered once per product, not per variant) which correctly seeds
  `average_unit_cost_cents`; a product's cost basis itself is written directly to
  `product_cost_history` at product-creation time (no receipt needed for that, since
  there's no stock yet to receive). Photos are resized/compressed client-side
  (`js/image.js`) before upload, since a phone photo can be several MB and a thumbnail
  doesn't need to be — they go to Supabase Storage's `product-images` bucket in real mode,
  or a `localStorage`-backed mock in demo mode (see below). Price updates insert a new
  append-only `product_prices` row per the immutability design, never editing the old one.
  Each variant row has a "Print label" button, and each product has a "Print all labels"
  button, both rendering barcode/price labels via `js/labels.js` (see step 3 above). A
  variant can optionally carry a **reorder threshold** (see step 11 below). Also on this
  page: a **discount codes** manager (create/list/toggle active) and a self-service
  **manager PIN** setter (see step 9 below) — both manager/owner only, like everything else
  here.
- **`stock-take.html`** — counts **variants**, not products (a size/color has its own stock,
  so it has its own count). Any role can count their own location; managers/owner can pick
  either. Shows system quantity vs. a counted-quantity input per variant with a live
  variance indicator, then "Complete stock take" writes a `stock_counts` +
  `stock_count_items` batch and transitions the count to `completed`, which is what
  triggers the reconciliation (`fn_apply_stock_count_completion` in the real schema,
  mirrored in `mockClient.js` for demo mode) that sets `quantity_available` to exactly what
  was physically counted. **Now offline-capable**: a completed count that fails to reach the
  server (or is finished while already offline) queues and replays automatically, the same
  mechanism checkout has always used.
- **`purchase-orders.html`** — manager/owner only. Raise a PO (supplier — typed name,
  found-or-created — destination location, currency, per-variant lines of quantity +
  expected cost), then record receipts against it (full or partial); each receipt is a real
  `stock_receipts`/`stock_receipt_items` row, so cost/stock update exactly like any other
  receipt in the system. The PO card shows ordered/received/remaining per line and its own
  status. Arriving via a "Reorder" link from `inventory.html`'s low-stock badge
  (`?variant=<id>`) pre-selects that variant in the new-line form.
- **`returns.html`** — search a sale by receipt #, date range, or customer; process a
  return per line with a reason and refund method, restocking the right variant/location
  and reversing COGS/profit using the sale's original recorded cost. Over-returning is
  rejected. **Now offline-capable**: a return that fails to reach the server (or is
  attempted while already offline) queues the same way a sale does and replays once back
  online — search itself still needs connectivity (it reads current sales from the server),
  but processing the return does not.
- **`customers.html`** — add/search customers, view each one's purchase history.
  `pos.html` gained optional name/phone fields that attach a customer to a sale.
- **`reports.html`** — manager/owner only. Total sales/profit/transactions for a date range,
  a daily/weekly/monthly sales table, product performance (best sellers first), a monthly
  detail table per product, a Z-report (cash reconciliation by payment method for one day),
  and an "Export to Excel" button producing a multi-sheet `.xlsx`. See step 10 above.
- **`activity.html`** — manager/owner only. Who's currently online (heartbeat-based, "seen
  in the last 2 minutes"), plus a filterable log of logins/logouts/sales/stock
  changes/edits/refunds/discount actions with the acting user and timestamp. See the
  presence + activity log note above.
- Every page above ships with a working `mockClient.js` implementation too — none of this
  needs a live Supabase project to try.

## Bugs found and fixed this pass

Not introduced by the steps 9–11 batch, but found while building it and blocking correct
behavior for reporting/returns — worth flagging since they were silent (no error shown
anywhere in the UI):

- **`product_prices` and `product_cost_history` inserts collided under the demo mock's
  dedup logic.** Both tables' `id` column carries a Postgres default
  (`gen_random_uuid()`) that the mock (`mockClient.js`) doesn't replicate, and `admin.js`'s
  inserts into these two tables never set `id` explicitly. The mock's upsert path treats two
  rows with the same `id` — including two rows that both simply lack one, i.e. `undefined
  === undefined` — as a duplicate and silently drops the second. Net effect: **every product
  created after the very first one had no retail price row and no cost history row**, making
  it invisible in `pos.html`'s product grid (filtered out for having no price) and unable to
  be sold; editing an existing product's price (`updatePrice()`) was equally silently
  dropped, since it hit the exact same collision. Fixed by having `admin.js` set `id`
  (`crypto.randomUUID()`) and `effective_date` explicitly on every insert into these two
  tables, matching the same "explicit rather than relying on a DB default the mock doesn't
  have" discipline already used elsewhere (see `purchase-orders.js`'s `quantity_received: 0`
  note). Verified with a Node test creating two products back-to-back and confirming both
  keep independent, correct prices, and that a price edit actually changes what's displayed.
- **`v_sale_items` was never wired up in the demo mock at all** — `mockClient.js`'s table
  dispatcher had no case for it, so every query against that view (used by `returns.html` to
  find returnable lines, and now by `reports.html` for all profit figures) silently returned
  an empty array. Returns therefore always showed "nothing on this receipt is returnable",
  and no `sale_items` row ever carried `unit_cost_at_sale_cents`/
  `cost_of_goods_sold_cents`/`gross_profit_cents` — those columns were simply never
  populated on insert in the mock. Fixed by adding the missing case (mirroring the real
  view, which is just `sale_items` with role-based column masking — masking itself isn't
  replicated in demo mode, matching the mock's existing convention for the other masked
  views) and adding `populateSaleItemCostSnapshot()`, which mirrors
  `fn_populate_sale_item_cost_snapshot()`'s real logic exactly: look up whichever
  `product_cost_history` row was in effect as of the *sale's own* `created_at`, not "now".
  Verified with a Node test that sells a seeded variant, return checks `v_sale_items` come
  back with correct COGS/profit, then processes a return against that same sale item and
  confirms the stock and `v_sale_item_returns` both update correctly.
- **`sw.js`'s app-shell cache list still referenced `transfers.html`/`js/transfers.js`**
  after they were deleted. `cache.addAll()` is all-or-nothing — a single 404 aborts the
  entire install step — so this would have made the service worker fail to install *at all*,
  silently breaking offline support for the whole app, not just the deleted page. Fixed by
  removing the stale entries and adding the batch's new pages (`reports.html`,
  `activity.html`, and their scripts) to the shell list, with the cache version bumped so
  existing installs pick up the corrected list.

## What's NOT built yet (still ahead, per the build prompt's step order)

- Editing a product's name/description after creation, editing a variant's size/color/
  SKU/barcode, or deactivating either — `admin.html` only creates products/variants and
  updates prices right now.
- A quick "just add stock to a variant" shortcut with no paperwork — stock now arrives via
  `admin.html`'s variant-creation receipt, `purchase-orders.html`'s PO receiving (step 5),
  or a stock take correcting the count upward. All three go through the real
  `stock_receipts`/`stock_receipt_items` mechanism (or, for a stock take, direct
  reconciliation) — there's just no single-field "add N units" bypass for a manager who
  doesn't want to raise a PO first. A receiving screen with landed-cost fields
  (freight/customs/etc., which the schema already supports) is also still ahead — PO
  receiving currently treats the PO line's expected cost as the actual landed cost.
- A dedicated supplier list/edit screen — `admin.html` still auto-creates/reuses "Manual
  Entry" for its own quick product setup, but `purchase-orders.html` (step 5) now lets you
  type a real supplier name, which is found-or-created properly; there's just no page to
  browse/edit the supplier list itself yet.
- Expenses entry. (`reports.html` now covers total sales/profit, product performance, and a
  Z-report — see step 10 above — but expense tracking itself, e.g. rent/utilities against
  the `expenses` table the original schema already has, has no UI yet, so profit figures
  are gross profit on goods sold, not net of overhead.)
- A settings UI for `app_settings.manual_discount_cap_cents` (the manual-discount-before-PIN
  threshold) — it exists and is enforced at checkout, but changing it today means a direct
  DB/API update, not a form anywhere in the app.
- Excel export (`reports.html`) dumps the core raw tables (Sales, Sale Items, Products,
  Variants, Customers) for backup/analysis — it does not export the on-screen aggregated
  report views (e.g. a pre-summed "monthly detail" sheet) as their own separate sheets; a
  user wanting that recomputes it from the raw sheets or reads it off the report page itself.
- Barcode *scanning* via camera — a USB/Bluetooth barcode scanner (the common
  types-then-Enter kind) works today against `pos.js`'s search box with no extra
  integration (see step 4 above). A camera-based scanner UI (using a phone's own camera to
  read a barcode, for a device with no separate scanner hardware) is not built.
- Multi-currency **split** tender — `sale_payments` supports more than one payment row per
  sale, but the checkout UI only ever writes one. Full split-tender UI is a stretch goal.
- Location picker on checkout — moot for now since there's only one location left after the
  steps 9–11 batch collapsed the two-location model into one (see the top-level README's
  judgment-calls section); `pos.js` still always sells at `profile.primary_location_id`,
  which every role (including owner) must have set for RLS to allow checkout at all. Would
  become relevant again only if a second location were ever reintroduced.
- Below-minimum wholesale quantity manager-approval gate — currently just blocks checkout
  with a message rather than routing to an approval flow.
- An admin flow for creating `user_profiles` rows (assigning roles to new staff accounts).
  Today that's a manual SQL insert after creating the `auth.users` account.

## Brand assets

Real logo files, not placeholders:

- **`icons/favicon.png`** (1600×1600, opaque white background) — the app icon: browser
  tab favicon, PWA manifest icon, and `apple-touch-icon` on every page.
- **`img/logo.png`** (1080×1080, transparent background) — the full "Subtle Accessories"
  wordmark + tagline. Used on the login screen and at the top of the printed receipt.
- **`img/Subtle Accessories.svg`** — an alternate version of the wordmark on a **black**
  background, not currently used anywhere. Every page here is light-themed, so there's no
  dark surface for it to sit on yet; it's kept in case a dark-themed context (a dark mode
  toggle, a dark marketing page, etc.) comes up later.

## Known limitations

- The service worker caches the app shell (HTML/CSS/JS) for offline loading, but it does
  **not** cache the Supabase CDN script or any API responses — those are intentionally left
  to the network. Offline behavior for *data* (checkout, stock takes, returns, sync) is
  handled entirely by the IndexedDB outbox, not by HTTP caching. First load of any page
  still requires being online once, to install the service worker and cache the shell. (See
  "Bugs found and fixed this pass" above — the shell list itself had gone stale after
  `transfers.html` was deleted, which would have broken this entirely; that's fixed now.)
- **Admin/product-variant writes, purchase orders, and customer creation remain
  online-only by design** — only checkout, stock takes, and returns queue offline. These are
  back-office actions a manager does at a desk, not shop-floor actions that must survive a
  dead connection at the till; scoping the offline queue to the shop-floor paths keeps it
  simple rather than generalizing it to every write in the app.
- **Reports (`reports.html`) are online-only** — they need a complete, current view of sales
  history to be meaningful, so there's no offline/cached fallback for this page, unlike the
  shop-floor pages above.
- **Presence is heartbeat-based, not real-time** — "online" means `last_seen_at` was updated
  within the last 2 minutes (via a 60-second heartbeat from every open authenticated page),
  not a live socket connection. A device that loses power or network ungracefully will still
  show "online" for up to ~2 minutes after it actually went away.
