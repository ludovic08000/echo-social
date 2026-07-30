import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const migration = source('supabase/migrations/20260730020000_aegis_account_authorized_devices.sql').toLowerCase();
const identity = source('src/lib/crypto/deviceIdentity.ts');
const signedList = source('src/lib/crypto/signedDeviceList.ts');
const fanout = source('src/lib/messaging/multiDeviceFanout.ts');
const registry = source('src/e2ee-session/deviceRegistry.ts');
const ratchet = source('src/lib/crypto/deviceRatchet.ts');

// These are architecture tests: they prevent a later refactor from silently
// reintroducing the exact self-signing, route omission and unbound-header bugs.
describe('Aegis stage 3 architecture', () => {
  it('anchors every device in the stable account signing key', () => {
    expect(identity).toContain('accountSigningPrivateKey');
    expect(identity).toContain('verifyDeviceAuthorization');
    expect(identity).toContain("protocol: 'forsure-aegis-device-authorization'");
    expect(identity).not.toContain('signDeviceIdentityBinding');
    expect(signedList).toContain('verifyPublicIdentityBinding');
    expect(signedList).toContain('verifyDeviceAuthorization');
  });

  it('removes the self-signed schema instead of keeping a second reader', () => {
    expect(migration).toContain('drop column if exists device_identity_signature');
    expect(migration).toContain('drop column if exists device_identity_version');
    expect(migration).toContain('device_authorization_signature');
    expect(migration).toContain('account_identity_mismatch');
    expect(migration).not.toContain('p_device_identity_version');
    expect(migration).toContain('drop function if exists public.get_signed_device_list(uuid) cascade');
    expect(migration).toContain('aegis_send_rpc_was_removed');
  });

  it('keeps one canonical identity registry and marks only current routes eligible', () => {
    const sesameStart = migration.indexOf('create function public.get_sesame_device_list');
    const sesameEnd = migration.indexOf('revoke all on function public.get_sesame_device_list', sesameStart);
    const registrySql = migration.slice(sesameStart, sesameEnd);
    expect(registrySql).toContain('device_authorization_signature');
    expect(registrySql).toContain('is_routable boolean');
    expect(registrySql).toContain('device.revoked_at');
    expect(registrySql).not.toContain('device_signed_prekeys spk');
    expect(migration).not.toContain('create or replace function public.get_signed_device_list');
    expect(migration).toContain('create or replace function public.get_device_copies_for_messages');
    expect(fanout).toContain("rpc('get_device_copies_for_messages'");
    expect(fanout).not.toContain(".from('message_device_copies')");
  });

  it('publishes SPKs and OPKs through authenticated atomic RPCs', () => {
    expect(migration).toContain('create or replace function public.publish_device_signed_prekey');
    expect(migration).toContain('perform pg_advisory_xact_lock');
    expect(migration).toContain('create or replace function public.publish_device_one_time_prekeys');
    expect(migration).toContain('for update skip locked');
  });

  it('never omits an authorized route because it is old or locally quarantined', () => {
    expect(registry).not.toContain('MAX_DEVICE_STALE_MS');
    expect(registry).not.toContain('isDeviceTooOld');
    expect(fanout).toContain('const targets = route.targets;');
    expect(fanout).not.toContain('.filter(device => !isKnownInvalidDeviceId(device.deviceId))');
  });

  it('authenticates every Ratchet header and rejects compatibility branches', () => {
    expect(ratchet).toContain('createAegisSessionId');
    expect(ratchet).toContain('parseAegisRatchetPayload');
    expect(ratchet).not.toContain('isHeaderBoundSession');
    expect(ratchet).not.toContain('HEADER_BOUND_SESSION_PREFIX');
  });
});
