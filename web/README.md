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
- **`pos.html`** — full checkout flow: product/price grid (retail or wholesale toggle,
  respecting `min_wholesale_qty`), cart, discount/tax entry, one payment method per sale,
  the offline path (queued in IndexedDB, replayed automatically once connectivity returns
  — `js/db.js` + `js/sync.js`), and a printable Subtle Accessories receipt (`js/receipt.js`)
  shown immediately after checkout, with a "Print" button (`window.print()` + `@media print`
  rules that hide everything but the receipt itself — works with any regular printer;
  thermal receipt printer integration is hardware-specific follow-up work, not built here).
  Responsive down to phone width — this is the page meant to run on a laptop, tablet, or
  phone at checkout.
- **`inventory.html`** — read-only stock levels per location, manager/owner only (cost
  column comes from `v_inventory_balances`, which the database itself nulls out for anyone
  else — this page doesn't have to enforce that, RLS already does).
- **`admin.html`** — manager/owner only. Add a product: SKU, name, barcode, currency,
  retail/wholesale price, minimum wholesale quantity, cost price, initial stock + location,
  and a photo (resized/compressed client-side in `js/image.js` before upload, since a phone
  photo can be several MB and a thumbnail doesn't need to be). A product always gets a cost
  basis on creation — via a proper stock receipt if there's initial stock (which also seeds
  `average_unit_cost_cents` correctly), or a direct `product_cost_history` row if not — since
  the sales trigger refuses to sell anything with no recorded cost. Photos go to Supabase
  Storage's `product-images` bucket (public read, manager/owner write — see the
  `admin_and_stock_take` migration) in real mode, or a `localStorage`-backed mock in demo
  mode (see below). The product list below the form supports updating retail/wholesale
  price (inserts a new append-only `product_prices` row, per the immutability design —
  never edits the old one).
- **`stock-take.html`** — any role can count their own location; managers/owner can pick
  either. Shows system quantity vs. a counted-quantity input per product with a live
  variance indicator, then "Complete stock take" writes a `stock_counts` + `stock_count_items`
  batch and transitions the count to `completed`, which is what triggers the reconciliation
  (`fn_apply_stock_count_completion` in the real schema, mirrored in `mockClient.js` for
  demo mode) that sets `quantity_available` to exactly what was physically counted.

## What's NOT built yet (still ahead, per the build prompt's step order)

- Editing a product's name/SKU/barcode after creation, or deactivating one — `admin.html`
  only adds products and updates prices right now.
- Adding stock to an *existing* product (a proper "receive stock" flow) — today, more stock
  only arrives via `admin.html`'s one-time initial receipt or a stock take correcting the
  count upward. A dedicated receiving screen with landed-cost fields (freight/customs/etc.,
  which the schema already supports) is still ahead.
- Supplier management UI — `admin.html` auto-creates/reuses a single "Manual Entry" supplier
  for every product; there's no screen to add real suppliers yet.
- Stock transfers UI (moving stock between the two locations) — the DB logic exists and
  works, no screen calls it yet.
- Returns/refunds UI — the DB logic (`sale_item_returns`) exists and works, no screen calls
  it yet.
- Expenses entry, the profitability dashboard.
- Barcode *scanning* (a camera/scanner feeding the product search box) — `pos.js`'s search
  already matches on `barcode` if a product has one, so a USB/Bluetooth barcode scanner that
  types-and-presses-Enter (the common cheap-scanner behavior) works today without any extra
  code; a camera-based scanner UI is not built.
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
