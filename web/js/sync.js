// Replays the local outbox in order once the device is back online. This is the client
// half of PRD section 1.2: the sale already happened locally (client-generated UUID,
// optimistic local record); this just pushes it to Supabase, which is authoritative for
// stock/cost reconciliation once the row lands (see fn_apply_sale_item_inventory_impact
// and fn_populate_sale_item_cost_snapshot in the sales_and_returns migration).

import { getClient } from './supabaseClient.js';
import { getPendingOutbox, markOutboxSynced } from './db.js';

let syncing = false;

async function pushSale(client, { sale, items, payments }) {
  // upsert + ignoreDuplicates (== INSERT ... ON CONFLICT DO NOTHING) so a retry after a
  // partial failure (e.g. the sale row landed but sale_items didn't) re-sends everything
  // harmlessly instead of hitting a primary-key conflict on the parts that already synced.
  const { error: saleError } = await client
    .from('sales')
    .upsert({ ...sale, sync_status: 'synced' }, { onConflict: 'id', ignoreDuplicates: true });
  if (saleError) throw saleError;

  // unit_cost_at_sale_cents is deliberately omitted -- the server trigger populates it
  // from product_cost_history as of `sale.created_at`. See the README's "judgment calls".
  const { error: itemsError } = await client
    .from('sale_items')
    .upsert(items.map((item) => ({ ...item, sale_id: sale.id })), { onConflict: 'id', ignoreDuplicates: true });
  if (itemsError) throw itemsError;

  if (payments?.length) {
    const { error: paymentsError } = await client
      .from('sale_payments')
      .upsert(payments.map((payment) => ({ ...payment, sale_id: sale.id })), { onConflict: 'id', ignoreDuplicates: true });
    if (paymentsError) throw paymentsError;
  }
}

export async function replayOutbox(onProgress) {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  try {
    const client = getClient();
    const pending = await getPendingOutbox();
    pending.sort((a, b) => a.created_at.localeCompare(b.created_at));

    for (const entry of pending) {
      try {
        if (entry.entity_type === 'sale') {
          await pushSale(client, entry.payload);
        }
        await markOutboxSynced(entry.id);
        onProgress?.({ id: entry.id, status: 'synced' });
      } catch (err) {
        console.error('Sync failed for outbox entry', entry.id, err);
        onProgress?.({ id: entry.id, status: 'error', error: err });
        // Left as 'pending' -- retried on the next pass. A row that's genuinely invalid
        // (e.g. a product deleted since) will keep failing; surfacing that to a manager
        // for manual resolution is future work, not handled here yet.
      }
    }
  } finally {
    syncing = false;
  }
}

export function initSyncListeners(onProgress) {
  window.addEventListener('online', () => replayOutbox(onProgress));
  replayOutbox(onProgress);
  setInterval(() => replayOutbox(onProgress), 30000);
}
