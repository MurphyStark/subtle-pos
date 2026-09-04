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

Then open `http://localhost:8080`. Before anything will actually work, fill in
`js/config.js` with a real Supabase project URL + anon key (see `../README.md`), apply the
migrations, and create at least one `auth.users` + matching `user_profiles` row to sign in
with (Supabase Studio's Authentication tab, or `supabase auth` CLI, then insert the
`user_profiles` row by hand for now — there's no admin UI for that yet, see below).

## What's actually built in this pass

- **`index.html`** — login (Supabase email/password auth).
- **`pos.html`** — full checkout flow: product/price grid (retail or wholesale toggle,
  respecting `min_wholesale_qty`), cart, discount/tax entry, one payment method per sale,
  and the offline path: if the network request fails (or the device is already offline),
  the sale is queued in IndexedDB and replayed automatically once connectivity returns
  (`js/db.js` + `js/sync.js`), with a status banner showing queued/syncing state.
- **`inventory.html`** — read-only stock levels per location, manager/owner only (cost
  column comes from `v_inventory_balances`, which the database itself nulls out for anyone
  else — this page doesn't have to enforce that, RLS already does).

## What's NOT built yet (still ahead, per the build prompt's step order)

- Product/supplier/cost CRUD (step 2) — right now products and cost history can only be
  seeded via SQL; there's no UI for a manager to add a product or record a cost change.
- Stock receiving / landed cost entry, stock counts, transfers UI (steps 3, 6).
- Returns/refunds UI (step 7) — the DB logic (`sale_item_returns`) exists and works, no
  screen calls it yet.
- Expenses entry, the profitability dashboard (steps 8–9).
- Barcode scanning and receipt printing (step 10).
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

## Known limitation

The service worker caches the app shell (HTML/CSS/JS) for offline loading, but it does
**not** cache the Supabase CDN script or any API responses — those are intentionally left
to the network. Offline behavior for *data* (checkout, sync) is handled entirely by the
IndexedDB outbox, not by HTTP caching. First load of any page still requires being online
once, to install the service worker and cache the shell.
