import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cryptoMigration = readFileSync(
  'supabase/migrations/20260811143000_signal_style_route_crypto_validation.sql',
  'utf8',
);
const entrypointMigration = readFileSync(
  'supabase/migrations/20260811143100_guard_all_device_route_entrypoints.sql',
  'utf8',
);
const approvalFunction = readFileSync(
  'supabase/functions/approve-device-enrollment/index.ts',
  'utf8',
);

describe('Signal-style server route trust validation', () => {
  it('uses PostgreSQL Ed25519 verification for the canonical account/device/SPK chain', () => {
    expect(cryptoMigration).toContain('pgsodium.crypto_sign_verify_detached');
    expect(cryptoMigration).toContain('forsure-aegis-account-identity');
    expect(cryptoMigration).toContain('forsure-aegis-device-authorization');
    expect(cryptoMigration).toContain('aegis_verify_account_binding');
    expect(cryptoMigration).toContain('aegis_verify_device_authorization');
    expect(cryptoMigration).toContain('aegis_verify_signed_prekey');
  });

  it('makes Sesame routability depend on cryptographic validity, not field presence', () => {
    const sesameStart = cryptoMigration.indexOf(
      'create or replace function public.get_sesame_device_list',
    );
    expect(sesameStart).toBeGreaterThanOrEqual(0);
    const sesame = cryptoMigration.slice(sesameStart);

    expect(sesame).toContain('d.crypto_invalid_at is null');
    expect(sesame).toContain('public.aegis_verify_account_binding(');
    expect(sesame).toContain('public.aegis_verify_device_authorization(');
    expect(sesame).toContain('public.aegis_verify_signed_prekey(');
  });

  it('verifies a Signed PreKey before delegating to the existing atomic publisher', () => {
    const publisherStart = cryptoMigration.indexOf(
      'create function public.publish_device_signed_prekey(',
    );
    expect(publisherStart).toBeGreaterThanOrEqual(0);
    const publisher = cryptoMigration.slice(publisherStart);
    const verifyIndex = publisher.indexOf('public.aegis_verify_signed_prekey(');
    const publishIndex = publisher.indexOf(
      'public.publish_device_signed_prekey_pre_signal_validation(',
    );

    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(verifyIndex);
    expect(publisher.slice(0, publishIndex)).toContain('DEVICE_SPK_SIGNATURE_INVALID');
  });

  it('keeps old mutation implementations unreachable directly after wrapping them', () => {
    expect(cryptoMigration).toContain(
      'rename to finalize_device_account_binding_pre_signal_validation',
    );
    expect(cryptoMigration).toContain(
      'rename to publish_device_signed_prekey_pre_signal_validation',
    );
    expect(cryptoMigration).toContain(
      'rename to publish_device_one_time_prekeys_pre_signal_validation',
    );
    expect(cryptoMigration).toMatch(
      /revoke all on function public\.publish_device_signed_prekey_pre_signal_validation\([\s\S]*?from public, anon, authenticated, service_role/,
    );
  });

  it('does not accept an already-bound device before re-verifying the exact authorization', () => {
    const bindStart = approvalFunction.indexOf('if (action === "bind")');
    expect(bindStart).toBeGreaterThanOrEqual(0);
    const bindBlock = approvalFunction.slice(bindStart);

    const invalidAuthorizationCheck = bindBlock.indexOf(
      'DEVICE_AUTHORIZATION_SIGNATURE_INVALID',
    );
    const existingFastPath = bindBlock.indexOf(
      'device.binding_status === "bound"',
    );

    expect(invalidAuthorizationCheck).toBeGreaterThanOrEqual(0);
    expect(existingFastPath).toBeGreaterThan(invalidAuthorizationCheck);
    expect(bindBlock).toContain('device.device_authorization_signature === signature');
  });

  it('guards compatibility route entrypoints with the verified Sesame trust set', () => {
    expect(entrypointMigration).toContain(
      'create or replace function public.bind_device_account',
    );
    expect(entrypointMigration).toContain(
      'public.finalize_device_account_binding(',
    );
    expect(entrypointMigration).toContain(
      'create or replace function public.mark_current_device_route_ready',
    );
    expect(entrypointMigration).toContain('public.aegis_verify_account_binding(');
    expect(entrypointMigration).toContain('public.aegis_verify_device_authorization(');
    expect(entrypointMigration).toContain('public.aegis_verify_signed_prekey(');
    expect(entrypointMigration).toContain(
      'create or replace function public.complete_current_device_synchronization',
    );
    expect(entrypointMigration).toContain('public.get_sesame_device_list(v_uid)');
    expect(entrypointMigration).toContain(
      'create or replace function public.get_canonical_remote_device_identity',
    );
    expect(entrypointMigration).toContain(
      'create or replace function public.list_active_devices_for_user',
    );
  });

  it('quarantines historical invalid trust without synthesizing replacement signatures', () => {
    expect(cryptoMigration).toContain("crypto_invalid_reason = case");
    expect(cryptoMigration).toContain("'DEVICE_AUTHORIZATION_SIGNATURE_INVALID'");
    expect(cryptoMigration).not.toMatch(
      /set\s+device_authorization_signature\s*=\s*(?!trim\(p_device_authorization_signature\))/i,
    );
  });
});
