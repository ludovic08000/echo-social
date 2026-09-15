import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const identityMigration = source('supabase/migrations/20260730090000_aegis_clean_rebuild.sql').toLowerCase();
const libsignalMigration = source('supabase/migrations/20260813162000_libsignal_protocol_cutover.sql').toLowerCase();
const routeCutover = source('supabase/migrations/20260915180000_require_libsignal_bundle_for_route.sql').toLowerCase();
const identity = source('src/lib/crypto/deviceIdentity.ts');
const deviceTrust = source('src/lib/crypto/deviceLinkTrust.ts');
const fanout = source('src/lib/messaging/multiDeviceFanout.ts');
const registry = source('src/e2ee-session/deviceRegistry.ts');
const runtime = source('src/lib/crypto/libsignalRuntime.ts');

describe('Aegis Libsignal architecture', () => {
  it('anchors every device in the stable account signing key', () => {
    expect(identity).toContain('accountSigningPrivateKey');
    expect(identity).toContain('verifyDeviceAuthorization');
    expect(identity).toContain("protocol: 'forsure-aegis-device-authorization'");
    expect(identity).not.toContain('signDeviceIdentityBinding');
    expect(deviceTrust).toContain('verifyPublicIdentityBinding');
    expect(deviceTrust).toContain('verifyDeviceAuthorization');
  });

  it('keeps one canonical identity registry and only current routes eligible', () => {
    expect(identityMigration).toContain('drop column if exists device_identity_signature');
    expect(identityMigration).toContain('device_authorization_signature');
    expect(libsignalMigration).toContain('create or replace function public.get_sesame_device_list');
    expect(libsignalMigration).toContain('device_libsignal_prekey_bundles');
    expect(libsignalMigration).toContain('is_routable boolean');
    expect(fanout).toContain("rpc('get_device_copies_for_messages'");
    expect(fanout).not.toContain(".from('message_device_copies')");
  });

  it('publishes and claims PQXDH bundles through authenticated atomic RPCs', () => {
    expect(libsignalMigration).toContain('create or replace function public.publish_libsignal_prekey_bundle');
    expect(libsignalMigration).toContain('perform pg_advisory_xact_lock');
    expect(libsignalMigration).toContain('create or replace function public.claim_libsignal_prekey_bundle');
    expect(libsignalMigration).toContain('for update skip locked');
  });

  it('uses no custom SPK table in final route readiness', () => {
    expect(routeCutover).toContain('device_libsignal_prekey_bundles');
    expect(routeCutover).not.toContain('device_signed_prekeys');
    expect(routeCutover).not.toContain('aegis_verify_signed_prekey');
  });

  it('never omits an authorized route because it is old or locally quarantined', () => {
    expect(registry).not.toContain('MAX_DEVICE_STALE_MS');
    expect(registry).not.toContain('isDeviceTooOld');
    expect(fanout).toContain('const targets = route.targets;');
    expect(fanout).not.toContain('.filter(device => !isKnownInvalidDeviceId(device.deviceId))');
  });

  it('routes encryption and decryption only through Libsignal', () => {
    expect(runtime).toContain('encryptLibsignalMessage');
    expect(runtime).toContain('decryptLibsignalMessage');
    expect(runtime).toContain("rpc('claim_libsignal_prekey_bundle'");
    expect(runtime).not.toContain('HEADER_BOUND_SESSION_PREFIX');
  });
});
