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
- ⏳ **`pos.html` (checkout) is currently broken** — it still queries products by the old
  flat-SKU shape (`product_id` on `sale_items`, prices/sku joined directly off `products`).
  Reworking it for a size/color picker is step 4, deliberately scoped as its own reviewable
  change rather than bundled into step 2. Until then, checkout will not load products
  correctly against either a real Supabase project or the current `mockClient.js`.
- Steps 3 (barcode labels), 5 (purchase orders/transfers), 6 (returns), 7 (receipts, partly
  done — see below), 8 (customers), 9 (promotions), 10 (reporting), 11 (low-stock alerts)
  are still ahead.

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
- **`pos.html`** — **currently broken, see "Fashion-retail evolution" above.** Prior to the
  product_variants migration it had: a full checkout flow (product/price grid with
  retail/wholesale toggle, cart, discount/tax, one payment method per sale), the offline
  path (queued in IndexedDB, replayed automatically once connectivity returns via
  `js/db.js` and `js/sync.js`), and a printable Subtle Accessories receipt
  (`js/receipt.js`) with a "Print" button (`window.print()` and `@media print` rules that
  hide everything but the receipt — works with any regular printer; thermal receipt
  printer integration is hardware-specific follow-up work, not built here). All of that
  logic is still in place and will carry over once step 4 reworks it to pick a variant
  instead of a bare product.
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
- **`stock-take.html`** — counts **variants**, not products (a size/color has its own stock,
  so it has its own count). Any role can count their own location; managers/owner can pick
  either. Shows system quantity vs. a counted-quantity input per variant with a live
  variance indicator, then "Complete stock take" writes a `stock_counts` +
  `stock_count_items` batch and transitions the count to `completed`, which is what
  triggers the reconciliation (`fn_apply_stock_count_completion` in the real schema,
  mirrored in `mockClient.js` for demo mode) that sets `quantity_available` to exactly what
  was physically counted.

## What's NOT built yet (still ahead, per the build prompt's step order)

- Editing a product's name/description after creation, editing a variant's size/color/
  SKU/barcode, or deactivating either — `admin.html` only creates products/variants and
  updates prices right now.
- Adding stock to an *existing* variant (a proper "receive stock" flow) — today, more stock
  only arrives via `admin.html`'s one-time variant-creation receipt or a stock take
  correcting the count upward. A dedicated receiving screen with landed-cost fields
  (freight/customs/etc., which the schema already supports) is still ahead.
- Supplier management UI — `admin.html` auto-creates/reuses a single "Manual Entry" supplier
  for every product; there's no screen to add real suppliers yet.
- Stock transfers UI (moving stock between the two locations) — the DB logic exists and
  works, no screen calls it yet.
- Returns/refunds UI — the DB logic (`sale_item_returns`) exists and works, no screen calls
  it yet.
- Expenses entry, the profitability dashboard.
- Barcode *scanning* (a camera/scanner feeding the product search box) and printed barcode
  *labels* (step 3) — barcode now lives on `product_variants`, which `pos.js` doesn't
  search yet (see "Fashion-retail evolution" above); a USB/Bluetooth barcode scanner that
  types-and-presses-Enter will work once step 4 wires variant search back up, with no
  extra code needed for that class of scanner. A camera-based scanner UI is not built.
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
- Real app icons — `icons/icon.svg` is a plain placeholder (a green square with "S"), and
  `apple-touch-icon` points at that same SVG, which iOS Safari may not render as a home
  screen icon (it has historically wanted PNG there) — it'll likely fall back to a page
  screenshot on iOS specifically. Swap in real PNG icons (multiple sizes) when branded ones
  exist.

## Known limitation

The service worker caches the app shell (HTML/CSS/JS) for offline loading, but it does
**not** cache the Supabase CDN script or any API responses — those are intentionally left
to the network. Offline behavior for *data* (checkout, sync) is handled entirely by the
IndexedDB outbox, not by HTTP caching. First load of any page still requires being online
once, to install the service worker and cache the shell.
