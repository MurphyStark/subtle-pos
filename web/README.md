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
  history. `transfers.html` covers the "simple" stock-transfer flow: request a transfer of
  a variant between locations (any role can request FROM their own location, matching the
  RLS already built for this back in the original schema), then a manager/owner can
  "Approve & mark received" in one step, which snapshots the source location's
  weighted-average cost onto the transfer and blends it into the destination's average
  once received.
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
- Steps 9 (promotions), 10 (reporting), 11 (low-stock alerts) are still ahead.

## Demo mode

`js/config.js` currently still has its placeholder Supabase URL. Rather than that meaning
nothing works, `js/supabaseClient.js` detects the placeholder and automatically swaps in
`js/mockClient.js` — a stand-in that implements exactly the subset of the Supabase API this
app calls (including `.storage.*`), backed by realistic sample data (10 products, both
locations, four demo accounts — one per role) persisted to `localStorage`. The login page
shows one-click sign-in buttons for each role plus a "Reset demo data" button. Selling
something in checkout visibly decrements stock on the Inventory page, adding a product in
Admin (photo included — stored as a data URL in `localStorage` standing in for a real
Storage bucket) shows up immediately, and completing a stock take reconciles the count —
all the same as the real thing would.

**This is a real dependency, not a toy — it's what makes the deployed site demoable before
a Supabase project exists.** Swap-out is automatic: once `js/config.js` has a real project
URL + anon key (see `../README.md`), demo mode turns itself off and every page talks to the
real Supabase project instead. No other file needs to change. At that point you'll also
need to create at least one real `auth.users` + matching `user_profiles` row to sign in
with (Supabase Studio's Authentication tab, or `supabase auth` CLI, then insert the
`user_profiles` row by hand for now — there's no admin UI for that yet, see below).

## What's actually built in this pass

- **`index.html`** — login (Supabase email/password auth).
- **`pos.html`** — full checkout flow, variant-aware (see step 4 above): product grid
  (retail or wholesale toggle, respecting `min_wholesale_qty`) where a multi-variant
  product opens a size/color picker and a single-variant one adds straight to cart; a
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
  button, both rendering barcode/price labels via `js/labels.js` (see step 3 above).
- **`stock-take.html`** — counts **variants**, not products (a size/color has its own stock,
  so it has its own count). Any role can count their own location; managers/owner can pick
  either. Shows system quantity vs. a counted-quantity input per variant with a live
  variance indicator, then "Complete stock take" writes a `stock_counts` +
  `stock_count_items` batch and transitions the count to `completed`, which is what
  triggers the reconciliation (`fn_apply_stock_count_completion` in the real schema,
  mirrored in `mockClient.js` for demo mode) that sets `quantity_available` to exactly what
  was physically counted.
- **`purchase-orders.html`** — manager/owner only. Raise a PO (supplier — typed name,
  found-or-created — destination location, currency, per-variant lines of quantity +
  expected cost), then record receipts against it (full or partial); each receipt is a real
  `stock_receipts`/`stock_receipt_items` row, so cost/stock update exactly like any other
  receipt in the system. The PO card shows ordered/received/remaining per line and its own
  status.
- **`transfers.html`** — any role can request a transfer of a variant from their own
  location; a manager/owner can "Approve & mark received" in one step. Snapshots the
  source's weighted-average cost onto the transfer so the destination's average stays
  correct once it lands.
- **`returns.html`** — search a sale by receipt #, date range, or customer; process a
  return per line with a reason and refund method, restocking the right variant/location
  and reversing COGS/profit using the sale's original recorded cost. Over-returning is
  rejected.
- **`customers.html`** — add/search customers, view each one's purchase history.
  `pos.html` gained optional name/phone fields that attach a customer to a sale.
- Every page above ships with a working `mockClient.js` implementation too — none of this
  needs a live Supabase project to try.

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
- Expenses entry, the profitability dashboard.
- Barcode *scanning* via camera — a USB/Bluetooth barcode scanner (the common
  types-then-Enter kind) works today against `pos.js`'s search box with no extra
  integration (see step 4 above). A camera-based scanner UI (using a phone's own camera to
  read a barcode, for a device with no separate scanner hardware) is not built.
- Multi-currency **split** tender — `sale_payments` supports more than one payment row per
  sale, but the checkout UI only ever writes one. Full split-tender UI is a stretch goal.
- Location picker on checkout — `pos.js` always sells at `profile.primary_location_id`.
  Every non-owner role must have that field set (required by RLS) or checkout will fail
  with a `location_id` not-null violation. The owner role is allowed by RLS to sell at
  either location, but the UI doesn't yet expose a way to pick one — give the owner account
  a `primary_location_id` too until a location switcher exists.
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

## Known limitation

The service worker caches the app shell (HTML/CSS/JS) for offline loading, but it does
**not** cache the Supabase CDN script or any API responses — those are intentionally left
to the network. Offline behavior for *data* (checkout, sync) is handled entirely by the
IndexedDB outbox, not by HTTP caching. First load of any page still requires being online
once, to install the service worker and cache the shell.
