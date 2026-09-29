// Demo-mode stand-in for the Supabase client, used automatically (see supabaseClient.js)
// whenever js/config.js still has its placeholder project URL -- i.e. before a real
// Supabase project exists. Implements exactly the subset of the Supabase JS API this app
// actually calls (including `.storage.*`), backed by realistic seed data persisted to
// localStorage so a demo's actions -- a completed sale, a stock take, a new product --
// survive a page reload.
//
// This is a real dependency, not a footnote: swap-out is automatic. Fill in real values in
// config.js and this file stops being used entirely -- nothing else in web/ changes.
//
// SHAPE NOTE: this mirrors the real schema's product_variants model (see the
// product_variants migration) -- products carry name/description/currency/pricing/cost
// only; sku/barcode/physical stock live on product_variants. Every product has at least
// one variant, same as the real migration's zero-data-loss backfill guarantees.

// v4: PRODUCT_SEED replaced with the real Subtle Accessories catalog -- bumped so anyone
// with an existing demo session (still on the old placeholder products in localStorage)
// gets reseeded automatically instead of staying stuck on stale sample data.
// v5: full 107-variant catalog (WhatsApp + photos + price list) and the Warehouse location.
// v6: accounts are now Tracy (owner), Tanya (cashier) and Admin -- user_profiles is seeded
// from DEMO_ACCOUNTS, so the old demo people must be reseeded away.
const STATE_KEY = 'subtle-pos-demo-state-v6';
const SESSION_KEY = 'subtle-pos-demo-session-v1';

// Two locations: the shop everyone sells from, and a Warehouse that only the ADMIN can see
// or touch -- mirrors the warehouse_location + admin_role migrations' locations_select
// policy and restrictive can_access_location() policies. See canSeeRow() below.
const SHOP_ID = 'loc-shop';
const WAREHOUSE_ID = 'loc-warehouse';
export const DEMO_LOCATIONS = [
  { id: SHOP_ID, name: 'Subtle Accessories Shop', location_type: 'retail' },
  { id: WAREHOUSE_ID, name: 'Warehouse', location_type: 'warehouse' },
];

const MANUAL_SUPPLIER_ID = 'supplier-manual';

// The shop's real people: Tracy (shop owner) and Tanya (cashier) sign in with any password,
// one click from the login page. The Admin account is the only one that can see the
// Warehouse, so it is NOT offered as a one-click button (see login.js) and needs a real
// password -- only its SHA-256 is stored here, so reading this file doesn't reveal it.
// An unknown email is rejected rather than falling back to some default account.
//
// Static identity fields only (email/name/role) -- the actual queryable, mutable
// user_profiles row (manager_pin, last_seen_at) lives in state.user_profiles, seeded from
// this list, so those mutations persist across reloads the same way every other table's
// writes do.
export const DEMO_ACCOUNTS = [
  { id: 'user-owner', email: 'tracy@subtlepos.demo', full_name: 'Tracy', role: 'owner', primary_location_id: 'loc-shop' },
  { id: 'user-cashier', email: 'tanya@subtlepos.demo', full_name: 'Tanya', role: 'cashier', primary_location_id: 'loc-shop' },
  {
    id: 'user-admin',
    email: 'admin@subtlepos.demo',
    full_name: 'Admin',
    role: 'admin',
    primary_location_id: 'loc-shop',
    passwordSha256: '7d97462affbd5da5488b01213dedb7b950c3cd5e70ecd3085a6938f0ac572bda',
    hiddenFromQuickLogin: true,
  },
];

async function sha256Hex(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Demo PINs so the manager-PIN discount-approval flow (step 9) is testable out of the box
// without first visiting a settings screen. Real deployments start with manager_pin null.
const DEMO_MANAGER_PINS = { 'user-owner': '1234' };

// GENERATED from "Subtle Accessories Stock Tracker.xlsx" (Products + Stock Levels sheets)
// -- regenerate rather than hand-editing. One product per name (a name whose variants have
// different prices is split, since price lives on the product); one variant per SKU row.
// Products with no retail price yet are left out, since they can't be sold.
//   - cost: taken from the tracker's Cost Price; where blank, seeded EQUAL to retail (zero
//     margin) as an explicit placeholder -- gross profit on reports.html reads $0 until
//     real costs are entered.
//   - qty / warehouseQty: the tracker's Opening Store / Opening Warehouse counts.
// Barcode and reorder_threshold are blank in the tracker and left null/unset.
const PRODUCT_SEED = [
  {
    name: "Chanel Quilted Flap Bag",
    category: "Bags",
    description: null,
    retail: 8500,
    cost: 8500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-CHN-BLK", color: "Black, pearl top handle, chain strap", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Christian Dior Saddle Bag",
    category: "Bags",
    description: null,
    retail: 7500,
    cost: 7500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-DIO-BLK", color: "Black", qty: 0, warehouseQty: 0 },
      { sku: "SUB-DIO-WHT", color: "White", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "D&G Logo Shoulder Bag",
    category: "Bags",
    description: null,
    retail: 7500,
    cost: 7500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-DGH-BLK", color: "Black patent", qty: 0, warehouseQty: 0 },
      { sku: "SUB-DGH-RED", color: "Red patent", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Gucci Half-Moon Bag",
    category: "Bags",
    description: null,
    retail: 10000,
    cost: 10000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-GUB-WHT", color: "White quilted", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Jacquemus Long Handbag",
    category: "Bags",
    description: null,
    retail: 7000,
    cost: 7000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-JAQ-BLK", color: "Black", qty: 0, warehouseQty: 0 },
      { sku: "SUB-JAQ-PNK", color: "Pink", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Louis Vuitton Twist Bag",
    category: "Bags",
    description: null,
    retail: 9000,
    cost: 9000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-LVB-BRN", color: "Brown", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Louis Vuitton Twist Bag (Cream)",
    category: "Bags",
    description: null,
    retail: 11000,
    cost: 11000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-LVB-CRM", color: "Cream", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Prada Patent Shoulder Bag",
    category: "Bags",
    description: null,
    retail: 8500,
    cost: 8500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-PRA-BLK", color: "Black", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "YSL Hobo Shoulder Bag",
    category: "Bags",
    description: null,
    retail: 8500,
    cost: 8500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-YSB-BLK", color: "Black", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "DG Belt",
    category: "Belts",
    description: null,
    retail: 7000,
    cost: 7000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-DGB-BLK", color: "Black with Gold Heart Buckle", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Fendi Belt",
    category: "Belts",
    description: null,
    retail: 3500,
    cost: 3500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-FEN-TAN", color: "Tan/Brown", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Gucci Belt",
    category: "Belts",
    description: null,
    retail: 7000,
    cost: 7000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-GUC-BLK", color: "Black, GG Buckle", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Gucci Belt (Silver)",
    category: "Belts",
    description: null,
    retail: 2500,
    cost: 2500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-GUS-SLV", color: "Black strap, Silver GG Buckle", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Gucci Belt (Two-Tone)",
    category: "Belts",
    description: null,
    retail: 7000,
    cost: 7000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-GUT-BLK", color: "Black strap, silver/gold GG buckle", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Loewe Belt",
    category: "Belts",
    description: null,
    retail: 2500,
    cost: 2500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-LOE-GLD", color: "Gold", qty: 0, warehouseQty: 0 },
      { sku: "SUB-LOE-SLV", color: "Silver", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "YSL Belt",
    category: "Belts",
    description: null,
    retail: 2500,
    cost: 2500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-YSL-BLK", color: "Black", qty: 0, warehouseQty: 0 },
      { sku: "SUB-YSL-GLD", color: "Black, gold buckle", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Brūmate Era Tumbler 40oz",
    category: "Drinkware",
    description: "Hydration made stylish and effortless! 100% leakproof.",
    retail: 4000,
    cost: 4000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-BMT-BLK", color: "Black 1.18ltrs", qty: 0, warehouseQty: 0 },
      { sku: "SUB-BMT-MBL", color: "Mist Blue 1.18ltrs", qty: 0, warehouseQty: 0 },
      { sku: "SUB-BMT-NUD", color: "Nude 1.18ltrs", qty: 0, warehouseQty: 0 },
      { sku: "SUB-BMT-RTP", color: "Rose Taupe 1.18ltrs", qty: 0, warehouseQty: 0 },
      { sku: "SUB-BMT-SFG", color: "Seafoam Green 1.18ltrs", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "FlipStraw Stanley",
    category: "Drinkware",
    description: null,
    retail: 3000,
    cost: 3000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-FSS-BLK", color: "Black Leakproof 1.18L", qty: 0, warehouseQty: 0 },
      { sku: "SUB-FSS-BLU", color: "Blue Leakproof 1.18L", qty: 0, warehouseQty: 0 },
      { sku: "SUB-FSS-HPK", color: "Hot Pink Leakproof 1.18L", qty: 0, warehouseQty: 0 },
      { sku: "SUB-FSS-MPK", color: "Marble Pink Leakproof 1.18L", qty: 0, warehouseQty: 0 },
      { sku: "SUB-FSS-NUD", color: "Nude Leakproof 1.18L", qty: 0, warehouseQty: 0 },
      { sku: "SUB-FSS-WHT", color: "White Leakproof 1.18L", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "IceFlow Flip Straw 2.0 Tumbler 591ml",
    category: "Drinkware",
    description: null,
    retail: 1500,
    cost: 1500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-IFS-BLK", color: "Black", qty: 0, warehouseQty: 0 },
      { sku: "SUB-IFS-LIL", color: "Lilac", qty: 0, warehouseQty: 0 },
      { sku: "SUB-IFS-PNK", color: "Pink", qty: 0, warehouseQty: 0 },
      { sku: "SUB-IFS-RQZ", color: "Rose Quartz", qty: 0, warehouseQty: 0 },
      { sku: "SUB-IFS-TWL", color: "Twilight", qty: 0, warehouseQty: 0 },
      { sku: "SUB-IFS-WHT", color: "White", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Owala SmoothSip® Slider 590Mls",
    category: "Drinkware",
    description: "For all your hot and cold beverages, 590mls. Leakproof.",
    retail: 3000,
    cost: 3000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-OWSS-BLK", color: "Black", qty: 0, warehouseQty: 0 },
      { sku: "SUB-OWSS-BLU", color: "Blue", qty: 0, warehouseQty: 0 },
      { sku: "SUB-OWSS-GWP", color: "Gloss White with pastel stars", qty: 0, warehouseQty: 0 },
      { sku: "SUB-OWSS-MWH", color: "Matte White", qty: 0, warehouseQty: 0 },
      { sku: "SUB-OWSS-PWP", color: "Pearl White body & Blush Pink lid", qty: 0, warehouseQty: 0 },
      { sku: "SUB-OWSS-RPK", color: "Rose Pink", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Stanley FlowState™ Quencher H2.0 Tumbler",
    category: "Drinkware",
    description: "Double-wall vacuum-insulated stainless steel.",
    retail: 1500,
    cost: 1500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-SFS-BLK", color: "Black 887ml leakproof", qty: 0, warehouseQty: 0 },
      { sku: "SUB-SFS-LIL", color: "Lilac", qty: 0, warehouseQty: 0 },
      { sku: "SUB-SFS-PNK", color: "Pink", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Stanley Quencher Tumbler",
    category: "Drinkware",
    description: null,
    retail: 1500,
    cost: 1500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-STQ-BHP", color: "Blush with Hot Pink handle 1.18L", qty: 0, warehouseQty: 0 },
      { sku: "SUB-STQ-BLK", color: "Black 1.18L", qty: 0, warehouseQty: 0 },
      { sku: "SUB-STQ-BPK", color: "Blush Pink 1.18L", qty: 0, warehouseQty: 0 },
      { sku: "SUB-STQ-CBL", color: "Cloudy Blue 1.18L", qty: 0, warehouseQty: 0 },
      { sku: "SUB-STQ-HPK", color: "Hot Pink 1.18L", qty: 0, warehouseQty: 0 },
      { sku: "SUB-STQ-LIL", color: "Lilac 1.18L", qty: 0, warehouseQty: 0 },
      { sku: "SUB-STQ-MBL", color: "Marble Blue 1.18L", qty: 0, warehouseQty: 0 },
      { sku: "SUB-STQ-MGR", color: "Marble Grey 1.18L", qty: 0, warehouseQty: 0 },
      { sku: "SUB-STQ-MNU", color: "Marble Nude 1.18L", qty: 0, warehouseQty: 0 },
      { sku: "SUB-STQ-NUD", color: "Nude 1.18L", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Stanley x Tyla Tyger 40oz Tumbler",
    category: "Drinkware",
    description: null,
    retail: 1500,
    cost: 1500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-STT-TYG", color: "Tyger 1.18L", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "The Quencher H2.0 FlowState Tumbler 414ml",
    category: "Drinkware",
    description: null,
    retail: 1500,
    cost: 1500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-QFS-BLK", color: "Black", qty: 0, warehouseQty: 0 },
      { sku: "SUB-QFS-BLU", color: "Blue", qty: 0, warehouseQty: 0 },
      { sku: "SUB-QFS-BPK", color: "Blush Pink", qty: 0, warehouseQty: 0 },
      { sku: "SUB-QFS-HPK", color: "Hot Pink", qty: 0, warehouseQty: 0 },
      { sku: "SUB-QFS-NUD", color: "Nude", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Astronaut Galaxy Projector",
    category: "Electronics",
    description: null,
    retail: 2000,
    cost: 2000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-PRJ-AST", color: "White", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Kids Instant Print Camera",
    category: "Electronics",
    description: "8GB storage capacity. Prints photos on the spot. Rechargeable battery.",
    retail: 3000,
    cost: 3000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-KID-STD", color: "Standard", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Celine Bucket Hat",
    category: "Hats",
    description: null,
    retail: 2000,
    cost: 2000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-CEH-BLK", color: "Black denim", qty: 0, warehouseQty: 0 },
      { sku: "SUB-CEH-BLU", color: "Blue denim", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "LV Monogram Bucket Hat",
    category: "Hats",
    description: null,
    retail: 2000,
    cost: 2000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-LVH-DBL", color: "Dark blue denim, tan trim", qty: 0, warehouseQty: 0 },
      { sku: "SUB-LVH-LBL", color: "Light blue denim", qty: 0, warehouseQty: 0 },
      { sku: "SUB-LVH-OLV", color: "Olive green denim", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Loewe Sun Hat",
    category: "Hats",
    description: null,
    retail: 2000,
    cost: 2000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-LSH-TBC", color: "Colour TBC", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Prada Cap (Codro)",
    category: "Hats",
    description: null,
    retail: 3000,
    cost: 3000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-PRC-TBC", color: "Colour TBC", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Aokulasic Automatic Mechanical Watch",
    category: "Watches",
    description: null,
    retail: 5000,
    cost: 5000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-AOK-GBK", color: "Gold frame, Black Leather Straps", qty: 0, warehouseQty: 0 },
      { sku: "SUB-AOK-SBK", color: "Silver frame, Black Leather Straps", qty: 0, warehouseQty: 0 },
      { sku: "SUB-AOK-SBR", color: "Silver frame, Brown Leather Straps", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "CAREKISO C124 Mechanical Watch",
    category: "Watches",
    description: "A bold timepiece combining luxury styling with fascinating mechanics.",
    retail: 7000,
    cost: 7000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-CRK-ALB", color: "All Black", qty: 0, warehouseQty: 0 },
      { sku: "SUB-CRK-BKS", color: "Black Straps, Silver Frame", qty: 0, warehouseQty: 0 },
      { sku: "SUB-CRK-BLU", color: "Blue Leather Straps", qty: 0, warehouseQty: 0 },
      { sku: "SUB-CRK-BRN", color: "Brown Leather Straps", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Carekiso Double Tourbillon",
    category: "Watches",
    description: null,
    retail: 8500,
    cost: 8500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-CDT-ALB", color: "All Black Leather Straps", qty: 0, warehouseQty: 0 },
      { sku: "SUB-CDT-BRN", color: "Brown Leather Straps", qty: 0, warehouseQty: 0 },
      { sku: "SUB-CDT-SBK", color: "Silver Frame, Black Leather Straps", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Forsining Diamond Mechanical Watch",
    category: "Watches",
    description: null,
    retail: 5000,
    cost: 5000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-FDM-GLD", color: "Gold", qty: 0, warehouseQty: 0 },
      { sku: "SUB-FDM-SLV", color: "Silver/Gold (2nd 'Gold' listing - confirm)", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Forsining FG8 Automatic",
    category: "Watches",
    description: null,
    retail: 5000,
    cost: 5000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-FG8-GLD", color: "Gold", qty: 0, warehouseQty: 0 },
      { sku: "SUB-FG8-SLV", color: "Silver", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Forsining Mechanical Watch",
    category: "Watches",
    description: null,
    retail: 6000,
    cost: 6000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-FOR-BLK", color: "Black - Stainless Steel Straps", qty: 0, warehouseQty: 0 },
      { sku: "SUB-FOR-GLD", color: "Gold - Stainless Steel Straps", qty: 0, warehouseQty: 0 },
      { sku: "SUB-FOR-SLV", color: "Silver - Stainless Steel Straps", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Mark Fairwhale FW-625 Dual Tourbillon Automatic",
    category: "Watches",
    description: null,
    retail: 9500,
    cost: 9500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-MFT-BLK", color: "Black", qty: 0, warehouseQty: 0 },
      { sku: "SUB-MFT-WHT", color: "White", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Mark Fairwhale FW6",
    category: "Watches",
    description: null,
    retail: 8000,
    cost: 8000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-MF6-BLK", color: "Black - Stainless Steel", qty: 0, warehouseQty: 0 },
      { sku: "SUB-MF6-SLV", color: "Silver - Stainless Steel", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Men's Binbond Mechanical Watch",
    category: "Watches",
    description: "Striking forged-carbon-inspired design.",
    retail: 4000,
    cost: 4000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-BIN-CGB", color: "Striped Charcoal Grey Frame, Black Rubber Straps", qty: 0, warehouseQty: 0 },
      { sku: "SUB-BIN-CGR", color: "Striped Charcoal Grey Frame, Red Rubber Straps", qty: 0, warehouseQty: 0 },
      { sku: "SUB-BIN-MRB", color: "Striped Maroon Frame, Black Rubber Straps", qty: 0, warehouseQty: 0 },
      { sku: "SUB-BIN-MRR", color: "Striped Maroon Frame, Red Rubber Straps", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Men's Spinning Wheel Watch",
    category: "Watches",
    description: "Perfect for car enthusiasts - unique 360° spinning wheel dial.",
    retail: 2500,
    cost: 2500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-SPW-GRN", color: "Green Straps", qty: 0, warehouseQty: 0 },
      { sku: "SUB-SPW-RED", color: "Red Straps", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Men's Tevise Mechanical Watch",
    category: "Watches",
    description: "Men's luxury watch - wear it daily.",
    retail: 4000,
    cost: 4000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-TEV-ALB", color: "All Black, Leather Straps", qty: 0, warehouseQty: 0 },
      { sku: "SUB-TEV-BKS", color: "Black Leather Straps, Silver Frame", qty: 0, warehouseQty: 0 },
      { sku: "SUB-TEV-BRG", color: "Brown Leather Straps, All Gold Frame", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "Men's Vintage Mechanical Watch",
    category: "Watches",
    description: "Men's luxury watch - wear it daily, it powers itself.",
    retail: 4000,
    cost: 4000, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-VIN-BLK", color: "Black Genuine Leather Straps", qty: 0, warehouseQty: 0 },
      { sku: "SUB-VIN-BRN", color: "Brown Genuine Leather Straps", qty: 0, warehouseQty: 0 },
    ],
  },
  {
    name: "SKMEI Spinning Wheel Watch",
    category: "Watches",
    description: null,
    retail: 3500,
    cost: 3500, // TODO: real cost not yet supplied -- seeded equal to retail (zero margin) as an explicit placeholder, not an estimate
    variants: [
      { sku: "SUB-SKM-SCP", color: "Scorpion", qty: 0, warehouseQty: 0 },
      { sku: "SUB-SKM-SPD", color: "Spider", qty: 0, warehouseQty: 0 },
      { sku: "SUB-SKM-SPT", color: "Sporty", qty: 0, warehouseQty: 0 },
    ],
  },
];

function buildSeed() {
  const products = [];
  const variants = [];
  const prices = [];
  const balances = [];
  const cost_history = [];

  PRODUCT_SEED.forEach((p, i) => {
    const productId = `prod-${i + 1}`;
    products.push({
      id: productId,
      name: p.name,
      description: p.description ?? null,
      category_id: null,
      base_currency: 'USD',
      min_wholesale_qty: 6,
      is_active: true,
      image_url: null,
    });
    prices.push({ product_id: productId, price_type: 'retail', unit_price_cents: p.retail, currency: 'USD', effective_date: '2026-01-01' });
    // Wholesale is optional -- the real catalog only supplies one price per product, so
    // most seeded products have no wholesale row at all (matching admin.html's own
    // optional wholesale-price field) rather than a garbage `undefined` price.
    if (p.wholesale != null) {
      prices.push({ product_id: productId, price_type: 'wholesale', unit_price_cents: p.wholesale, currency: 'USD', effective_date: '2026-01-01' });
    }
    cost_history.push({
      id: `cost-seed-${productId}`,
      product_id: productId,
      supplier_id: MANUAL_SUPPLIER_ID,
      unit_cost_cents: p.cost,
      currency: 'USD',
      effective_date: '2026-01-01',
      stock_receipt_id: null,
    });

    const variantDefs = p.variants ?? [{ size: null, color: null, skuSuffix: null, qty: p.qty, reorderThreshold: p.reorderThreshold }];
    variantDefs.forEach((v, vi) => {
      const variantId = `var-${productId}-${vi + 1}`;
      // v.sku (a full SKU straight from the real catalog) takes priority over the older
      // prefix+suffix scheme, which nothing in PRODUCT_SEED uses any more but is left as a
      // fallback in case a future seed entry finds it more convenient.
      const sku = v.sku ?? (v.skuSuffix ? `${p.sku}-${v.skuSuffix}` : p.sku);
      variants.push({
        id: variantId,
        product_id: productId,
        size: v.size ?? null,
        color: v.color ?? null,
        sku,
        barcode: null,
        is_active: true,
        reorder_threshold: v.reorderThreshold ?? null,
      });
      for (const [locationId, qty] of [[SHOP_ID, v.qty], [WAREHOUSE_ID, v.warehouseQty]]) {
        balances.push({
          id: `bal-${variantId}-${locationId}`,
          variant_id: variantId,
          location_id: locationId,
          quantity_available: qty ?? 0,
          average_unit_cost_cents: p.cost,
          currency: 'USD',
          needs_review: false,
          needs_review_reason: null,
          updated_at: new Date().toISOString(),
        });
      }
    });
  });

  return {
    products,
    variants,
    prices,
    balances,
    cost_history,
    suppliers: [{ id: MANUAL_SUPPLIER_ID, name: 'Manual Entry', contact_info: {}, voided_at: null }],
    stock_receipts: [],
    stock_receipt_items: [],
    stock_counts: [],
    stock_count_items: [],
    sales: [],
    sale_items: [],
    sale_payments: [],
    sale_item_returns: [],
    purchase_orders: [],
    purchase_order_items: [],
    inventory_transfers: [],
    user_profiles: DEMO_ACCOUNTS.map(({ passwordSha256, hiddenFromQuickLogin, ...a }) => ({ ...a, manager_pin: DEMO_MANAGER_PINS[a.id] ?? null, last_seen_at: null })),
    app_settings: [{ key: 'manual_discount_cap_cents', value: 2000, updated_at: new Date().toISOString() }],
    discount_codes: [
      {
        id: 'discount-seed-1',
        code: 'WELCOME10',
        discount_type: 'percentage',
        discount_value: 10,
        min_spend_cents: 0,
        valid_from: '2026-01-01T00:00:00.000Z',
        valid_until: null,
        is_active: true,
        created_by: 'user-owner',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    activity_log: [],
    inventory_transfer_items: [],
    customers: [],
    imageStore: {},
  };
}

// Every array a fresh session might not have (added in a later pass than the one that
// created a still-cached localStorage state) needs a default -- otherwise an old demo
// session left over from before a feature existed would crash on load instead of just
// picking the new feature up cleanly.
function backfillShape(loaded) {
  const fresh = buildSeed();
  for (const key of Object.keys(fresh)) {
    if (!(key in loaded)) loaded[key] = Array.isArray(fresh[key]) ? [] : fresh[key];
  }
  return loaded;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return backfillShape(JSON.parse(raw));
  } catch (err) {
    console.warn('Demo state failed to load, reseeding:', err);
  }
  const seed = buildSeed();
  localStorage.setItem(STATE_KEY, JSON.stringify(seed));
  return seed;
}

function saveState(state) {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

export function resetDemoData() {
  localStorage.removeItem(STATE_KEY);
  localStorage.removeItem(SESSION_KEY);
}

const state = loadState();

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(user) {
  if (user) localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  else localStorage.removeItem(SESSION_KEY);
}

// Mirrors the warehouse_location + admin_role migrations: anyone but the admin sees (and can write) nothing
// that lives at the Warehouse -- not the location itself, its balances, or any count,
// receipt, purchase order, sale or transfer touching it.
function canSeeRow(table, row) {
  if (loadSession()?.role === 'admin') return true;
  switch (table) {
    case 'locations':
      return row.id !== WAREHOUSE_ID;
    case 'v_inventory_balances':
    case 'stock_counts':
    case 'stock_receipts':
    case 'purchase_orders':
    case 'sales':
      return row.location_id !== WAREHOUSE_ID;
    case 'sale_item_returns':
    case 'v_sale_item_returns':
      return row.restock_location_id !== WAREHOUSE_ID;
    case 'inventory_transfers':
      return row.from_location_id !== WAREHOUSE_ID && row.to_location_id !== WAREHOUSE_ID;
    case 'inventory_transfer_items': {
      const transfer = state.inventory_transfers.find((t) => t.id === row.inventory_transfer_id);
      return !transfer || canSeeRow('inventory_transfers', transfer);
    }
    default:
      return true;
  }
}

function tableRows(table) {
  switch (table) {
    case 'products':
      return state.products;
    case 'product_variants':
      return state.variants;
    case 'product_prices':
      return state.prices;
    case 'product_cost_history':
      return state.cost_history;
    case 'suppliers':
      return state.suppliers;
    case 'stock_receipts':
      return state.stock_receipts;
    case 'stock_receipt_items':
      return state.stock_receipt_items;
    case 'stock_counts':
      return state.stock_counts;
    case 'stock_count_items':
      return state.stock_count_items;
    case 'v_inventory_balances':
      return state.balances;
    case 'locations':
      return DEMO_LOCATIONS;
    case 'user_profiles':
      return state.user_profiles;
    case 'app_settings':
      return state.app_settings;
    case 'discount_codes':
      return state.discount_codes;
    case 'activity_log':
      return state.activity_log;
    case 'sales':
      return state.sales;
    case 'sale_items':
    case 'v_sale_items':
      return state.sale_items;
    case 'sale_payments':
      return state.sale_payments;
    case 'sale_item_returns':
    case 'v_sale_item_returns':
      return state.sale_item_returns;
    case 'purchase_orders':
      return state.purchase_orders;
    case 'purchase_order_items':
      return state.purchase_order_items;
    case 'inventory_transfers':
      return state.inventory_transfers;
    case 'inventory_transfer_items':
      return state.inventory_transfer_items;
    case 'customers':
      return state.customers;
    default:
      return [];
  }
}

function findOrCreateBalance(variantId, locationId, currency) {
  let balance = state.balances.find((b) => b.variant_id === variantId && b.location_id === locationId);
  if (!balance) {
    balance = {
      id: `bal-${variantId}-${locationId}`,
      variant_id: variantId,
      location_id: locationId,
      quantity_available: 0,
      average_unit_cost_cents: 0,
      currency: currency ?? 'USD',
      needs_review: false,
      needs_review_reason: null,
      updated_at: new Date().toISOString(),
    };
    state.balances.push(balance);
  }
  return balance;
}

// Mirrors fn_populate_sale_item_cost_snapshot: looks up whatever product_cost_history row
// was in effect as of the parent sale's own created_at (not "now"), and freezes it onto the
// row -- exactly what the real BEFORE INSERT trigger does server-side, since a cashier's
// device can never be trusted (or, under RLS, even able) to know or send its own cost basis.
function populateSaleItemCostSnapshot(row, saleCreatedAt) {
  const variant = state.variants.find((v) => v.id === row.variant_id);
  if (!variant) throw new Error(`Unknown variant ${row.variant_id} for sale item`);
  const candidates = state.cost_history
    .filter((c) => c.product_id === variant.product_id && c.effective_date <= saleCreatedAt)
    .sort((a, b) => (a.effective_date < b.effective_date ? 1 : -1));
  const cost = candidates[0];
  if (!cost) {
    throw new Error(
      `No product_cost_history exists for product ${variant.product_id} (variant ${row.variant_id}) as of ${saleCreatedAt}; cannot record a sale with no cost basis to snapshot.`
    );
  }
  row.unit_cost_at_sale_cents = cost.unit_cost_cents;
  row.cost_of_goods_sold_cents = row.quantity * cost.unit_cost_cents;
  row.gross_profit_cents = row.quantity * row.unit_selling_price_cents - row.cost_of_goods_sold_cents;
}

// Mirrors fn_apply_sale_item_inventory_impact: decrement the selling location's stock the
// moment a sale_items row is written, so Inventory reflects a demo sale immediately.
function applySaleItemStockImpact(row) {
  const sale = state.sales.find((s) => s.id === row.sale_id);
  if (!sale) return;
  populateSaleItemCostSnapshot(row, sale.created_at);
  const balance = findOrCreateBalance(row.variant_id, sale.location_id, row.currency);
  balance.quantity_available -= row.quantity;
  balance.updated_at = new Date().toISOString();
}

// Mirrors fn_apply_stock_receipt_item: recompute the location's weighted-average cost and
// drop a product_cost_history row (still product_id-keyed -- cost is shared across a
// product's variants by design, see the product_variants migration), so admin-entered
// stock behaves exactly like a real stock receipt would against the live schema.
function applyStockReceiptItem(row) {
  const receipt = state.stock_receipts.find((r) => r.id === row.stock_receipt_id);
  if (!receipt) return;
  const variant = state.variants.find((v) => v.id === row.variant_id);
  if (!variant) return;
  const balance = findOrCreateBalance(row.variant_id, receipt.location_id, receipt.currency);

  const existingQty = balance.quantity_available;
  const existingAvg = balance.average_unit_cost_cents;
  const newQty = row.quantity;
  const newAvg =
    existingQty + newQty === 0
      ? 0
      : Math.round((existingQty * existingAvg + newQty * row.unit_landed_cost_cents) / (existingQty + newQty));

  balance.quantity_available = existingQty + newQty;
  balance.average_unit_cost_cents = newAvg;
  balance.updated_at = new Date().toISOString();

  state.cost_history.push({
    id: `cost-${crypto.randomUUID()}`,
    product_id: variant.product_id,
    supplier_id: receipt.supplier_id,
    unit_cost_cents: row.unit_landed_cost_cents,
    currency: receipt.currency,
    effective_date: new Date().toISOString(),
    stock_receipt_id: receipt.id,
  });
}

// Mirrors fn_apply_stock_count_completion: a stock take sets quantity_available to exactly
// what was physically counted, clearing any needs_review flag.
function applyStockCountCompletion(stockCountRow) {
  const items = state.stock_count_items.filter((i) => i.stock_count_id === stockCountRow.id);
  for (const item of items) {
    const balance = findOrCreateBalance(item.variant_id, stockCountRow.location_id);
    balance.quantity_available = item.counted_quantity;
    balance.needs_review = false;
    balance.needs_review_reason = null;
    balance.updated_at = new Date().toISOString();
  }
}

// Mirrors fn_apply_transfer_receipt: moves stock (and blends weighted-average cost) from
// the source location to the destination once a transfer reaches received/partially
// received. Deducts the source unconditionally -- by the time a transfer is marked
// received, the stock has already physically left the source location.
function applyTransferReceipt(transferRow) {
  const items = state.inventory_transfer_items.filter(
    (i) => i.inventory_transfer_id === transferRow.id && (i.quantity_received ?? 0) > 0
  );
  for (const item of items) {
    const fromBalance = findOrCreateBalance(item.variant_id, transferRow.from_location_id);
    fromBalance.quantity_available -= item.quantity_received;
    fromBalance.updated_at = new Date().toISOString();

    const toBalance = findOrCreateBalance(item.variant_id, transferRow.to_location_id);
    const existingQty = toBalance.quantity_available;
    const existingAvg = toBalance.average_unit_cost_cents;
    const incomingQty = item.quantity_received;
    const incomingCost = item.unit_cost_at_transfer_cents ?? 0;
    const newAvg =
      existingQty + incomingQty === 0
        ? 0
        : Math.round((existingQty * existingAvg + incomingQty * incomingCost) / (existingQty + incomingQty));
    toBalance.quantity_available = existingQty + incomingQty;
    toBalance.average_unit_cost_cents = newAvg;
    toBalance.updated_at = new Date().toISOString();
  }
}

// Mirrors fn_process_sale_item_return: validates the return quantity against what's still
// returnable, defaults restock_location_id to the original sale's location, and reverses
// COGS/gross profit using the ORIGINAL recorded unit cost -- never today's cost. Mutates
// `row` in place before it's stored, the same way a BEFORE INSERT trigger mutates NEW.
function processSaleItemReturn(row) {
  const saleItem = state.sale_items.find((i) => i.id === row.sale_item_id);
  if (!saleItem) throw new Error(`Unknown sale_item ${row.sale_item_id} for return`);

  const alreadyReturned = state.sale_item_returns
    .filter((r) => r.sale_item_id === row.sale_item_id)
    .reduce((sum, r) => sum + r.quantity_returned, 0);
  if (alreadyReturned + row.quantity_returned > saleItem.quantity) {
    throw new Error(
      `Cannot return ${row.quantity_returned} units: only ${saleItem.quantity - alreadyReturned} of ${saleItem.quantity} remain returnable`
    );
  }

  if (!row.restock_location_id) {
    const sale = state.sales.find((s) => s.id === saleItem.sale_id);
    row.restock_location_id = sale?.location_id ?? null;
  }

  row.cogs_reversed_cents = row.quantity_returned * saleItem.unit_cost_at_sale_cents;
  row.gross_profit_reversed_cents =
    row.quantity_returned * (saleItem.unit_selling_price_cents - saleItem.unit_cost_at_sale_cents);
}

// Mirrors fn_restock_sale_item_return: puts the returned quantity back into stock at
// whatever restock_location_id was resolved to above.
function restockSaleItemReturn(row) {
  const saleItem = state.sale_items.find((i) => i.id === row.sale_item_id);
  if (!saleItem) return;
  const balance = findOrCreateBalance(saleItem.variant_id, row.restock_location_id);
  balance.quantity_available += row.quantity_returned;
  balance.updated_at = new Date().toISOString();
}

function applyWrite(table, rows) {
  const target = tableRows(table);
  try {
    for (const row of rows) {
      // app_settings is keyed by `key`, not `id`, and needs real upsert-replace semantics
      // (the whole point is that the discount cap can be changed), not the
      // insert-once/ignore-duplicates behavior every other table here uses.
      if (table === 'app_settings') {
        const existing = target.find((r) => r.key === row.key);
        if (existing) Object.assign(existing, row);
        else target.push(row);
        continue;
      }
      if (!canSeeRow(table, row)) throw new Error('new row violates row-level security policy (Warehouse is admin-only)');
      if (target.find((r) => r.id === row.id)) continue; // upsert + ignoreDuplicates semantics
      if (table === 'sale_item_returns') processSaleItemReturn(row); // may throw; mutates row
      target.push(row);
      if (table === 'sale_items') applySaleItemStockImpact(row);
      if (table === 'stock_receipt_items') applyStockReceiptItem(row);
      if (table === 'stock_counts' && row.status === 'completed') applyStockCountCompletion(row);
      if (table === 'sale_item_returns') restockSaleItemReturn(row);
    }
  } catch (err) {
    return { data: null, error: { message: err.message } };
  }
  saveState(state);
  return { data: null, error: null };
}

function applyUpdate(table, patch, filters) {
  const target = tableRows(table);
  const matches = target.filter((r) => canSeeRow(table, r) && filters.every((f) => f(r)));
  for (const row of matches) {
    const wasCompleted = row.status === 'completed';
    const wasReceived = row.status === 'received' || row.status === 'partially_received';
    Object.assign(row, patch);
    if (table === 'stock_counts' && row.status === 'completed' && !wasCompleted) {
      applyStockCountCompletion(row);
    }
    if (table === 'inventory_transfers' && !wasReceived && (row.status === 'received' || row.status === 'partially_received')) {
      applyTransferReceipt(row);
    }
  }
  saveState(state);
  return { data: null, error: null };
}

class MockQuery {
  constructor(table) {
    this._table = table;
    this._filters = [];
    this._orderCol = null;
    this._orderAsc = true;
    this._single = false;
    this._write = null;
    this._updatePatch = null;
  }
  select() {
    return this;
  }
  eq(col, val) {
    this._filters.push((r) => r[col] === val);
    return this;
  }
  in(col, vals) {
    const set = new Set(vals);
    this._filters.push((r) => set.has(r[col]));
    return this;
  }
  order(col, opts = {}) {
    this._orderCol = col;
    this._orderAsc = opts.ascending !== false;
    return this;
  }
  single() {
    this._single = true;
    return this;
  }
  insert(rows) {
    this._write = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows) {
    this._write = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  update(patch) {
    this._updatePatch = patch;
    return this;
  }
  // Makes the builder itself awaitable, same shape as the real supabase-js client.
  then(resolve, reject) {
    this._run().then(resolve, reject);
  }
  async _run() {
    if (this._write) return applyWrite(this._table, this._write);
    if (this._updatePatch) return applyUpdate(this._table, this._updatePatch, this._filters);

    let rows = tableRows(this._table).filter((r) => canSeeRow(this._table, r) && this._filters.every((f) => f(r)));
    if (this._orderCol) {
      const col = this._orderCol;
      rows = rows.slice().sort((a, b) => {
        const cmp = a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0;
        return this._orderAsc ? cmp : -cmp;
      });
    }
    if (this._single) {
      return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'No matching row (demo data)' } };
    }
    return { data: rows, error: null };
  }
}

function fileToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.readAsDataURL(blob);
  });
}

// Stands in for Supabase Storage: "uploading" just base64-encodes the file into
// localStorage and "the public URL" is that data URL directly. Fine for a demo's scale;
// a real deployment uses the actual product-images bucket (see the admin_and_stock_take
// migration) instead of this.
function createMockStorage() {
  return {
    from(bucket) {
      return {
        async upload(path, fileOrBlob) {
          try {
            const dataUrl = await fileToDataUrl(fileOrBlob);
            state.imageStore[`${bucket}/${path}`] = dataUrl;
            saveState(state);
            return { data: { path }, error: null };
          } catch (err) {
            return { data: null, error: { message: err.message } };
          }
        },
        getPublicUrl(path) {
          return { data: { publicUrl: state.imageStore[`${bucket}/${path}`] ?? '' } };
        },
      };
    },
  };
}

export function createMockClient() {
  return {
    __isDemoClient: true,
    auth: {
      async signInWithPassword({ email, password }) {
        const match = DEMO_ACCOUNTS.find((u) => u.email.toLowerCase() === String(email ?? '').trim().toLowerCase());
        const passwordOk = match && (!match.passwordSha256 || (await sha256Hex(String(password ?? ''))) === match.passwordSha256);
        if (!passwordOk) {
          return { data: { session: null }, error: { message: 'Invalid login credentials' } };
        }
        const { passwordSha256, hiddenFromQuickLogin, ...sessionUser } = match;
        saveSession(sessionUser);
        return { data: { session: { user: { id: match.id } } }, error: null };
      },
      async getSession() {
        const user = loadSession();
        return { data: { session: user ? { user: { id: user.id } } : null } };
      },
      async signOut() {
        saveSession(null);
      },
    },
    from(table) {
      return new MockQuery(table);
    },
    storage: createMockStorage(),
    // Mirrors verify_manager_pin(): returns the matching manager/owner's id, or null --
    // never the PIN itself or which OTHER pins exist, matching the real RPC's contract.
    async rpc(fnName, params = {}) {
      if (fnName === 'verify_manager_pin') {
        const pin = params.p_pin;
        const match = pin
          ? state.user_profiles.find(
              (u) => u.manager_pin === pin && ['shop_manager', 'wholesale_manager', 'owner', 'admin'].includes(u.role)
            )
          : null;
        return { data: match ? match.id : null, error: null };
      }
      return { data: null, error: { message: `Unknown RPC function in demo mode: ${fnName}` } };
    },
  };
}
