// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

const code = ts.transpileModule(
  readFileSync('supabase/functions/mondial-relay/index.ts', 'utf8').replace(/^import[^;]+;\r?\n/gm, ''),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const validOrder = { id: 'order', buyer_id: 'buyer', order_number: 'ORD-SYNTHETIC', status: 'paid',
  payment_verified_at: '2026-10-18T20:00:00Z', order_items: [{ seller_id: 'shop-id' }],
  shipping_relay_city: 'Paris', shipping_relay_postcode: '75001', shipping_relay_address: 'adresse fictive',
  shipping_relay_id: '123456', subtotal: 10,
};
function fixture({ authenticated = true, visible = true, seller = true, order = validOrder, writeError = false, claimed = true, claimError = false, carrierFails = false } = {}) {
  let handler: (req: Request) => Promise<Response> = async () => new Response();
  const selections: { table: string; key: string; jwt: boolean }[] = [];
  const writes = vi.fn();
  let held = !claimed;
  const reservations = vi.fn();
  const createClient = (_url: string, key: string, options?: unknown) => ({ rpc: async (name: string, data: unknown) => {
    if (name === 'claim_marketplace_shipment') {
      reservations(data);
      if (claimError) return { data: null, error: new Error('DB unavailable') };
      const claimedNow = !held; held = true;
      return { data: { claimed: claimedNow, reconciliation_required: !claimedNow }, error: null };
    }
    writes(data); return { data: !writeError, error: writeError ? new Error('DB unavailable') : null };
  }, from: (table: string) => {
    selections.push({ table, key, jwt: Boolean(options) });
    const q = { select: () => q, eq: () => q, in: () => q, limit: () => q,
      single: async () => ({ data: order, error: null }),
      maybeSingle: async () => ({ data: table === 'seller_profiles' ? seller ? { id: 'shop-id' } : null : visible ? { id: 'order' } : null, error: null }),
      update: (data: unknown) => { writes(data); return q; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: writeError ? new Error('DB unavailable') : null }).then(resolve),
    }; return q;
  } });
  const fetch = vi.fn(async () => { if(carrierFails)throw new Error('Network lost');return new Response('<STAT>0</STAT><ExpeditionNum>12345678</ExpeditionNum><URL_Etiquette>/label.pdf</URL_Etiquette>'); });
  const env: Record<string, string> = { MONDIAL_RELAY_ENSEIGNE: 'synthetic', MONDIAL_RELAY_PRIVATE_KEY: 'synthetic',
    SUPABASE_URL: 'https://local.invalid', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' };
  new Function('serve', 'Deno', 'createClient', 'getCorsHeaders', 'requireAuthenticated', 'crypto', 'hexEncode', 'fetch', 'console', code)(
    (fn: typeof handler) => { handler = fn; }, { env: { get: (key: string) => env[key] } }, createClient, () => ({}),
    async () => authenticated ? { ok: true, userId: 'seller-user-id', token: 'synthetic-jwt' } : { ok: false, response: new Response(null, { status: 401 }) },
    { subtle: { digestSync: (_: string, data: Uint8Array) => createHash('md5').update(data).digest() } },
    (data: Uint8Array) => new TextEncoder().encode(Buffer.from(data).toString('hex')), fetch, { log: () => {}, error: () => {} },
  );
  const request = (body: unknown) => handler(new Request('https://local.invalid', {
    method: 'POST', headers: { Authorization: 'Bearer synthetic-jwt', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { request, fetch, writes, reservations, selections };
}
it('rejects unauthenticated tracking before database or carrier access', async () => {
  const f = fixture({ authenticated: false });
  expect((await f.request({ action: 'track', tracking_number: '12345678' })).status).toBe(401);
  expect(f.selections).toEqual([]); expect(f.fetch).not.toHaveBeenCalled();
});
it('does not let knowledge of a third-party tracking number grant access', async () => {
  const f = fixture({ visible: false });
  expect((await f.request({ action: 'track', tracking_number: '12345678' })).status).toBe(404);
  expect(f.selections).toEqual([{ table: 'orders', key: 'anon', jwt: true }]);
  expect(f.fetch).not.toHaveBeenCalled();
});
it('preserves authorized buyer/seller tracking through a caller-scoped read', async () => {
  const f = fixture();
  expect((await f.request({ action: 'track', tracking_number: '12345678' })).status).toBe(200);
  expect(f.fetch).toHaveBeenCalledOnce(); expect(f.selections[0].jwt).toBe(true);
});
it('authorizes the owner of the actual order-item shop, not a matching user/product id', async () => {
  const f = fixture();
  expect((await f.request({ action: 'create_shipment', order_id: 'order' })).status).toBe(200);
  expect(f.selections.map(s => s.table)).toEqual(['orders', 'seller_profiles']);
  expect(f.fetch).toHaveBeenCalledOnce(); expect(f.writes).toHaveBeenCalledOnce();
});
it('uses a persisted reservation before contacting the carrier and refuses a missing authority',async()=>{
  const held=fixture({claimed:false});
  expect((await held.request({action:'create_shipment',order_id:'order'})).status).toBe(409);
  expect(held.fetch).not.toHaveBeenCalled();
  const unavailable=fixture({claimError:true});
  expect((await unavailable.request({action:'create_shipment',order_id:'order'})).status).toBe(503);
  expect(unavailable.fetch).not.toHaveBeenCalled();
});
it('cannot recreate a carrier label after an unknown network outcome',async()=>{
  const f=fixture({carrierFails:true});
  expect((await f.request({action:'create_shipment',order_id:'order'})).status).toBe(500);
  expect((await f.request({action:'create_shipment',order_id:'order'})).status).toBe(409);
  expect(f.fetch).toHaveBeenCalledOnce();expect(f.writes).not.toHaveBeenCalled();
});
it('rejects another seller and unpaid/unverified orders without creating a label', async () => {
  const other = fixture({ seller: false });
  expect((await other.request({ action: 'create_shipment', order_id: 'order' })).status).toBe(403);
  expect(other.fetch).not.toHaveBeenCalled();
  const unpaid = fixture({ order: { ...validOrder, status: 'pending' } });
  expect((await unpaid.request({ action: 'create_shipment', order_id: 'order' })).status).toBe(409);
  expect(unpaid.fetch).not.toHaveBeenCalled();
});
it('reuses an existing label and does not report success after a failed local write', async () => {
  const existing = fixture({ order: { ...validOrder, tracking_number: '12345678', shipping_label_url: 'https://www.mondialrelay.fr/label.pdf' } as typeof validOrder });
  expect((await existing.request({ action: 'create_shipment', order_id: 'order' })).status).toBe(200);
  expect(existing.fetch).not.toHaveBeenCalled();
  const failed = fixture({ writeError: true });
  const response = await failed.request({ action: 'create_shipment', order_id: 'order' });
  expect(response.status).toBe(500); expect((await response.json()).error).toContain('avant de réessayer');
});
