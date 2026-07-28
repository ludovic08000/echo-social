import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260726120000_aegis_identity_route_stabilization.sql',
  ),
  'utf8',
).toLowerCase();
const deviceIdentityCutover = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260728070000_remove_crypto_device_fingerprint_recovery.sql',
  ),
  'utf8',
).toLowerCase();
const currentDevice = readFileSync(
  resolve(process.cwd(), 'src/lib/messaging/currentDevice.ts'),
  'utf8',
);

function functionBody(name: string, nextMarker: string): string {
  const start = migration.indexOf(name);
  const end = migration.indexOf(nextMarker, start + name.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe('Aegis identity and stable-route migration', () => {
  it('stores a verifiable X25519/Ed25519 identity binding', () => {
    expect(migration).toContain('identity_binding_version integer');
    expect(migration).toContain('identity_binding_signature text');
    expect(migration).toContain('identity.signing_key = root.identity_pub_b64');
    expect(migration).toContain('identity.identity_binding_version = 1');
  });

  it('keeps authorization distinct from route health', () => {
    expect(migration).toContain(
      "check (routing_status in ('ready', 'repairing', 'unavailable'))",
    );
    expect(migration).toContain("'device_revoked_or_rejected'");
    expect(migration).toContain("'device_key_mismatch'");
    expect(migration).toContain('perform public.ensure_primary_device_exists(v_uid)');
    expect(migration).toContain('mark_current_device_route_unavailable');
    expect(migration).toContain('quarantine_own_invalid_device_spk');
    expect(migration).toContain('bump_aegis_signed_prekey_route');
    expect(migration).toContain('spk.is_active = true');
  });

  it('recovers a revoked DeviceID instead of silently rotating around it', () => {
    const resolver = functionBody(
      'create or replace function public.resolve_device_id_by_fingerprints',
      'drop function if exists public.register_user_device_safe',
    );
    expect(resolver).toContain('device.revoked_at is not null');
    expect(resolver).toContain("device.approval_status = 'rejected'");
    expect(resolver).not.toContain('device.is_active = true');
    expect(resolver).not.toContain('invalid_e2ee_devices');
  });

  it('pins and locks one stable route version for the atomic send', () => {
    const send = functionBody(
      'create function public.aegis_send_message',
      'revoke all on function public.aegis_send_message',
    );
    expect(send).toContain('p_route_version text');
    expect(send).toContain('for share of route');
    expect(send).toContain('public.get_aegis_conversation_route_version');
    expect(send).toContain("'e2ee_device_list_stale'");
    expect(send).toContain('v_missing_count');
    expect(send).toContain('v_unexpected_count');
    expect(send).toContain('archive_body, aegis_route_version');
  });

  it('keeps the stable UUID idempotent and never erases message history', () => {
    expect(migration).toContain(
      'v_existing_sender = v_uid',
    );
    expect(migration).toContain(
      'v_existing_conversation = p_conversation_id',
    );
    expect(migration).toContain('v_existing_body = p_body');
    expect(migration).not.toMatch(/\btruncate\s+table\s+public\.messages\b/);
    expect(migration).not.toMatch(/\bdelete\s+from\s+public\.messages\b/);
  });

  it('never uses browser fingerprints as a cryptographic DeviceID', () => {
    expect(deviceIdentityCutover).toContain(
      'drop function if exists public.resolve_device_id_by_fingerprints',
    );
    expect(currentDevice).not.toContain(
      "supabase.rpc(\n            'resolve_device_id_by_fingerprints'",
    );
    expect(currentDevice).toContain('readDeviceIdFromIndexedDb');
    expect(currentDevice).toContain('writeDeviceIdToIndexedDb');
  });
});
