import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').toLowerCase();
const libsignalMigration = source('supabase/migrations/20260813162000_libsignal_protocol_cutover.sql');
const publisherMigration = source('supabase/migrations/20260910130517_0dc56e3c-0feb-4d30-9a4a-d66e8e247e8b.sql');
const routeCutover = source('supabase/migrations/20260915180000_require_libsignal_bundle_for_route.sql');
const registry = source('src/e2ee-session/deviceRegistry.ts');
const routeResolver = source('src/lib/messaging/aegisRouteResolver.ts');

describe('Aegis Libsignal route guards', () => {
  it('uses the canonical verified device registry', () => {
    expect(registry).toContain("rpc('list_active_devices_for_user'");
    expect(registry).toContain('ensureapproveddevicetrust');
    expect(registry).toContain('e2ee_device_registry_invalid');
    expect(routeResolver).toContain('sender_device_routable');
    expect(routeResolver).toContain('verifyroutedeviceidentityoffline');
  });

  it('binds destructive Libsignal bundle claims to participants and sender device', () => {
    expect(libsignalMigration).toContain('p_conversation_id uuid');
    expect(libsignalMigration).toContain('p_sender_device_id text');
    expect(libsignalMigration).toContain('mine.user_id=auth.uid()');
    expect(libsignalMigration).toContain('peer.user_id=p_user_id');
    expect(libsignalMigration).toContain('for update skip locked');
    expect(libsignalMigration).toContain('claim_libsignal_prekey_bundle(uuid,text,uuid,text)');
  });

  it('requires an approved bound device before publishing Libsignal bundles', () => {
    const start = publisherMigration.indexOf('create or replace function public.publish_libsignal_prekey_bundle');
    const end = publisherMigration.indexOf('create or replace function public.mark_current_device_route_ready', start);
    const publisher = publisherMigration.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(publisher).toMatch(/d\.approval_status\s*=\s*'approved'/);
    expect(publisher).toMatch(/d\.binding_status\s*=\s*'bound'/);
    expect(publisher).toContain('d.account_bound_at is not null');
  });

  it('marks a route ready only from the matching canonical Libsignal bundle', () => {
    expect(routeCutover).toContain('device.libsignal_device_number between 1 and 127');
    expect(routeCutover).toContain('from public.device_libsignal_prekey_bundles bundle');
    expect(routeCutover).toContain('bundle.device_number = device.libsignal_device_number');
    expect(routeCutover).not.toContain('device_signed_prekeys');
    expect(routeCutover).not.toContain('aegis_verify_signed_prekey');
  });

  it('rejects partial registries before fan-out mutation', () => {
    expect(registry).toContain('e2ee_device_registry_invalid');
    expect(registry).toContain('e2ee_device_registry_unavailable');
    expect(registry).toContain('e2ee_participant_route_unavailable');
  });
});
