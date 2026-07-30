import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const stage2 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260730010000_aegis_clean_transport.sql'),
  'utf8',
).toLowerCase();
const stage3 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260730020000_aegis_account_authorized_devices.sql'),
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

describe('Aegis stage 3 route guards', () => {
  it('uses one canonical device registry without the old projection', () => {
    expect(stage2).toContain('public.get_sesame_device_list');
    expect(stage2).not.toContain('public.get_signed_device_list');
    expect(stage3).toContain('drop function if exists public.get_signed_device_list(uuid)');
    expect(stage3).not.toContain('create or replace function public.get_signed_device_list');
  });

  it('separates historical identity verification from current routing', () => {
    expect(stage3).toContain('is_routable boolean');
    expect(stage3).toContain('device.revoked_at');
    expect(stage2).toContain('device.is_routable = true');
    expect(signedList).toContain('isRoutable: row.is_routable === true');
    expect(registry).toContain('.filter(t => t.isRoutable && !!t.devicePublicKey)');
  });

  it('binds destructive OPK claims to both users and the sender device', () => {
    expect(stage3).toContain('p_conversation_id uuid');
    expect(stage3).toContain('p_sender_device_id text');
    expect(stage3).toContain('participant.user_id = v_uid');
    expect(stage3).toContain('participant.user_id = p_user_id');
    expect(stage3).toContain('sender_device.is_routable = true');
    expect(stage3).toContain('claim_device_one_time_prekey(uuid,text,uuid,text)');
  });

  it('requires an approved device before publishing OPKs', () => {
    const start = stage3.indexOf('create or replace function public.publish_device_one_time_prekeys');
    const end = stage3.indexOf('create function public.claim_device_one_time_prekey', start);
    expect(stage3.slice(start, end)).toContain("coalesce(device.approval_status, 'approved') = 'approved'");
  });

  it('rejects partial registries before fan-out mutation', () => {
    expect(registry).toContain('E2EE_DEVICE_REGISTRY_INVALID');
    expect(registry).toContain('E2EE_DEVICE_REGISTRY_UNAVAILABLE');
    expect(registry).toContain('E2EE_PARTICIPANT_ROUTE_UNAVAILABLE');
  });
});
