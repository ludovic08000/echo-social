import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260730090000_aegis_clean_rebuild.sql'),
  'utf8',
).toLowerCase();
const registry = readFileSync(
  resolve(process.cwd(), 'src/e2ee-session/deviceRegistry.ts'),
  'utf8',
);
const signedList = readFileSync(
  resolve(process.cwd(), 'src/lib/crypto/signedDeviceList.ts'),
  'utf8',
);

describe('Aegis stage 3 route guards in the final schema', () => {
  it('uses one canonical device registry without recreating the old projection', () => {
    expect(migration).toContain('public.get_sesame_device_list');
    expect(migration).toContain('drop function if exists public.get_signed_device_list(uuid)');
    expect(migration).not.toContain('create or replace function public.get_signed_device_list');
  });

  it('separates historical identity verification from current routing', () => {
    expect(migration).toContain('is_routable boolean');
    expect(migration).toContain('device.revoked_at');
    expect(migration).toContain('device.is_routable = true');
    expect(signedList).toContain('isRoutable: row.is_routable === true');
    expect(registry).toContain('.filter(t => t.isRoutable && !!t.devicePublicKey)');
  });

  it('binds destructive OPK claims to both users and the sender device', () => {
    expect(migration).toContain('p_conversation_id uuid');
    expect(migration).toContain('p_sender_device_id text');
    expect(migration).toContain('participant.user_id = v_uid');
    expect(migration).toContain('participant.user_id = p_user_id');
    expect(migration).toContain('sender_device.is_routable = true');
    expect(migration).toContain('claim_device_one_time_prekey(uuid,text,uuid,text)');
  });

  it('requires an approved device before publishing OPKs', () => {
    const start = migration.indexOf('create or replace function public.publish_device_one_time_prekeys');
    const end = migration.indexOf('create function public.claim_device_one_time_prekey', start);
    expect(migration.slice(start, end)).toContain("coalesce(device.approval_status, 'approved') = 'approved'");
  });

  it('rejects partial registries before fan-out mutation', () => {
    expect(registry).toContain('E2EE_DEVICE_REGISTRY_INVALID');
    expect(registry).toContain('E2EE_DEVICE_REGISTRY_UNAVAILABLE');
    expect(registry).toContain('E2EE_PARTICIPANT_ROUTE_UNAVAILABLE');
  });
});
