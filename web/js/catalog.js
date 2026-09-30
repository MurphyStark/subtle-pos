import { resizeImage } from './image.js';

// Shared data helpers for the product, variant and stock-take pages: one place that knows
// how to load the catalog (products + variants + categories + latest price/cost + stock),
// and how stock actually changes (a stock receipt adds units; a stock count sets them).

export function variantLabel(variant) {
  return [variant?.size, variant?.color].filter(Boolean).join(' / ');
}

// Human reference for a stock count, e.g. ST-20260929-3F2A: the count's date plus the
// first characters of its id -- stable, unique enough to quote, and needs no counter table.
export function stockCountReference(count) {
  const d = new Date(count.completed_at ?? count.created_at);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `ST-${ymd}-${count.id.slice(0, 4).toUpperCase()}`;
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

export function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export async function loadCatalog(client) {
  const [
    { data: products },
    { data: variants },
    { data: categories },
    { data: prices },
    { data: costs },
    { data: balances },
    { data: locations },
  ] = await Promise.all([
    client.from('products').select('*'),
    client.from('product_variants').select('*'),
    client.from('categories').select('id, name').order('name'),
    client.from('product_prices').select('*').order('effective_date', { ascending: false }),
    client.from('product_cost_history').select('*').order('effective_date', { ascending: false }),
    client.from('v_inventory_balances').select('*'),
    client.from('locations').select('id, name'),
  ]);

  const latestPrice = {};
  for (const p of prices ?? []) {
    const key = `${p.product_id}:${p.price_type}`;
    if (!latestPrice[key]) latestPrice[key] = p; // already sorted newest-first
  }
  const latestCost = {};
  for (const c of costs ?? []) {
    if (!latestCost[c.product_id]) latestCost[c.product_id] = c;
  }
  const categoryName = Object.fromEntries((categories ?? []).map((c) => [c.id, c.name]));
  const balancesByVariant = {};
  for (const b of balances ?? []) (balancesByVariant[b.variant_id] ??= []).push(b);

  const variantsByProduct = {};
  for (const v of variants ?? []) (variantsByProduct[v.product_id] ??= []).push(v);

  const productById = {};
  for (const p of products ?? []) {
    productById[p.id] = {
      ...p,
      categoryName: categoryName[p.category_id] ?? '',
      retail: latestPrice[`${p.id}:retail`] ?? null,
      wholesale: latestPrice[`${p.id}:wholesale`] ?? null,
      cost: latestCost[p.id] ?? null, // null for roles that can't read cost history
      variants: (variantsByProduct[p.id] ?? []).sort((a, b) => (a.sku ?? '').localeCompare(b.sku ?? '')),
    };
  }

  const qty = (variantId, locationId = null) =>
    (balancesByVariant[variantId] ?? [])
      .filter((b) => !locationId || b.location_id === locationId)
      .reduce((sum, b) => sum + b.quantity_available, 0);

  return {
    products: Object.values(productById),
    productById,
    variantById: Object.fromEntries((variants ?? []).map((v) => [v.id, v])),
    categories: categories ?? [],
    locations: locations ?? [],
    balancesByVariant,
    qty,
  };
}

// Every product needs a cost basis before it can ever be sold (the sales trigger looks up
// product_cost_history and refuses to sell a variant of a product with none), and every
// stock receipt needs a supplier -- "Manual Entry" covers stock added by hand.
export async function getOrCreateManualSupplier(client) {
  const { data: existing } = await client.from('suppliers').select('id, name').eq('name', 'Manual Entry');
  if (existing?.[0]) return existing[0].id;
  const id = crypto.randomUUID();
  await client.from('suppliers').insert({ id, name: 'Manual Entry' });
  return id;
}

// Adds units at a location via a stock receipt (which also feeds the location's
// weighted-average cost -- see fn_apply_stock_receipt_item).
export async function receiveStock(client, { variantId, locationId, quantity, unitCostCents, currency, createdBy = null, notes = null }) {
  const supplierId = await getOrCreateManualSupplier(client);
  const receiptId = crypto.randomUUID();
  const { error: receiptError } = await client.from('stock_receipts').insert({
    id: receiptId,
    supplier_id: supplierId,
    location_id: locationId,
    purchase_cost_cents: unitCostCents * quantity,
    currency,
    sync_status: 'synced',
    created_by: createdBy,
    notes,
    received_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  });
  if (receiptError) throw new Error(receiptError.message);
  const { error: itemError } = await client.from('stock_receipt_items').insert({
    id: crypto.randomUUID(),
    stock_receipt_id: receiptId,
    variant_id: variantId,
    quantity,
    unit_landed_cost_cents: unitCostCents,
  });
  if (itemError) throw new Error(itemError.message);
  return receiptId;
}

// Records a completed stock count: inserted as draft with its items, then flipped to
// completed -- that transition is what sets each counted variant's quantity to exactly what
// was counted (fn_apply_stock_count_completion; mirrored in the demo mock). Only the
// variants in `items` are touched.
export async function recordStockCount(client, { locationId, countedBy, items, notes = null }) {
  const countId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const stockCount = {
    id: countId,
    location_id: locationId,
    status: 'draft',
    counted_by: countedBy,
    sync_status: 'synced',
    notes,
    created_at: nowIso,
    completed_at: nowIso,
  };
  const rows = items.map((i) => ({
    id: crypto.randomUUID(),
    stock_count_id: countId,
    variant_id: i.variant_id,
    counted_quantity: i.counted_quantity,
    system_quantity_at_count: i.system_quantity_at_count,
    notes: i.notes || null,
    created_at: nowIso,
  }));
  const { error: countError } = await client.from('stock_counts').insert(stockCount);
  if (countError) throw new Error(countError.message);
  const { error: itemsError } = await client.from('stock_count_items').insert(rows);
  if (itemsError) throw new Error(itemsError.message);
  const { error: statusError } = await client.from('stock_counts').update({ status: 'completed', completed_at: nowIso }).eq('id', countId);
  if (statusError) throw new Error(statusError.message);
  return { stockCount: { ...stockCount, status: 'completed' }, items: rows };
}

// Uploads a product photo (resized first) to the product-images bucket and points the
// product at it. A fresh file name each time, so browsers don't keep a cached old photo.
export async function uploadProductPhoto(client, file, productId) {
  const blob = await resizeImage(file);
  const path = `${productId}-${Date.now()}.jpg`;
  const { error } = await client.storage.from('product-images').upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
  if (error) throw new Error(error.message);
  const url = client.storage.from('product-images').getPublicUrl(path).data.publicUrl;
  const { error: updateError } = await client.from('products').update({ image_url: url }).eq('id', productId);
  if (updateError) throw new Error(updateError.message);
  return url;
}
