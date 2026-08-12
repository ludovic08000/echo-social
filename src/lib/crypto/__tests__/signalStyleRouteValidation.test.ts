import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cryptoMigration = readFileSync(
  'supabase/migrations/20260811143000_signal_style_route_crypto_validation.sql',
  'utf8',
);
const entrypointMigration = readFileSync(
  'supabase/migrations/20260811143100_guard_all_device_route_entrypoints.sql',
  'utf8',
);
const atomicApprovalMigration = readFileSync(
  'supabase/migrations/20260811143200_atomic_device_approval_authorization.sql',
  'utf8',
);
const approvalBridge = readFileSync(
  'supabase/migrations/20260809190000_temporary_device_crypto_bridges.sql',
  'utf8',
);
const approvalClient = readFileSync(
  'src/lib/crypto/deviceApprovalDecision.ts',
  'utf8',
);

describe('Signal-style server route trust validation', () => {
  it('declares pgsodium and aborts on a failing Ed25519 primitive self-test', () => {
    expect(cryptoMigration).toContain('create extension if not exists pgsodium');
    expect(cryptoMigration).toContain('AEGIS_ED25519_SELFTEST_FAILED');
    expect(cryptoMigration).toContain('AEGIS_ED25519_SELFTEST_FALSE_ACCEPT');
    expect(cryptoMigration).toMatch(/do\s+\$\$[\s\S]*?aegis_verify_ed25519\([\s\S]*?raise exception/i);
  });

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

  it('provides the predecessor RPCs before the Signal wrappers rename them', () => {
    expect(approvalBridge).toContain('create or replace function public.approve_device_enrollment_decision');
    expect(approvalBridge).toContain('create or replace function public.bind_device_account');
    expect(approvalBridge).toContain('DEVICE_POSSESSION_SIGNATURE_INVALID');
  });

  it('forces account authorization into the trusted-device approval transaction', () => {
    expect(approvalClient).toContain('signDeviceAuthorization');
    expect(approvalClient).toContain('loadIdentityKeys');
    expect(approvalClient).toContain('p_device_authorization_signature');
    expect(approvalClient).toContain('DEVICE_APPROVAL_ACCOUNT_PRIVATE_KEY_MISSING');
    expect(approvalClient).toContain("result.binding_status !== 'bound'");
    expect(approvalClient).toContain('result.account_authorized !== true');

    expect(atomicApprovalMigration).toContain(
      'rename to approve_device_enrollment_decision_pre_account_authorization',
    );
    expect(atomicApprovalMigration).toContain('DEVICE_AUTHORIZATION_SIGNATURE_REQUIRED');
    expect(atomicApprovalMigration).toContain('APPROVER_DEVICE_CRYPTO_TRUST_INVALID');
    expect(atomicApprovalMigration).toContain('public.aegis_verify_account_binding(');
    expect(atomicApprovalMigration).toContain('public.aegis_verify_device_authorization(');
    expect(atomicApprovalMigration).toContain('public.finalize_device_account_binding(');
    expect(atomicApprovalMigration).toContain('ATOMIC_DEVICE_APPROVAL_BINDING_FAILED');
    expect(atomicApprovalMigration).toContain("'approval_rolled_back', true");

    const wrapperMatch = atomicApprovalMigration.match(
      /create function public\.approve_device_enrollment_decision\(\s*p_decision text,\s*p_bootstrap_primary boolean,\s*p_approver_device_id text,\s*p_device_id text,\s*p_challenge_id uuid,\s*p_signature text,\s*p_device_authorization_signature text/i,
    );
    const wrapperStart = wrapperMatch?.index ?? -1;
    const compatibilityStart = atomicApprovalMigration.indexOf(
      '-- Compatibility overload:',
      wrapperStart,
    );
    expect(wrapperStart).toBeGreaterThanOrEqual(0);
    expect(compatibilityStart).toBeGreaterThan(wrapperStart);

    const atomicWrapper = atomicApprovalMigration.slice(wrapperStart, compatibilityStart);
    const verifyIndex = atomicWrapper.indexOf('public.aegis_verify_device_authorization(');
    const approvalIndex = atomicWrapper.indexOf(
      'v_result := public.approve_device_enrollment_decision_pre_account_authorization(',
    );
    const bindingIndex = atomicWrapper.indexOf(
      'v_binding := public.finalize_device_account_binding(',
    );

    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(approvalIndex).toBeGreaterThan(verifyIndex);
    expect(bindingIndex).toBeGreaterThan(approvalIndex);
  });

  it('removes the obsolete approval Edge Function in favor of the SQL RPC', () => {
    expect(existsSync('supabase/functions/approve-device-enrollment/index.ts')).toBe(false);
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
