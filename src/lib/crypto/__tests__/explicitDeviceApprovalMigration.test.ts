import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const explicitApprovalMigration = readFileSync(
  'supabase/migrations/20260806090000_require_explicit_device_approval.sql',
  'utf8',
).toLowerCase();

const serverVerificationMigration = readFileSync(
  'supabase/migrations/20260806110000_server_verify_device_approval.sql',
  'utf8',
).toLowerCase();

describe('explicit device approval migrations', () => {
  it('keeps the authenticated compatibility RPC fail-closed', () => {
    expect(explicitApprovalMigration).toContain('create or replace function public.approve_user_device');
    expect(serverVerificationMigration).toContain('create or replace function public.approve_user_device');
    expect(serverVerificationMigration).toContain('device_approval_verification_required');
    expect(serverVerificationMigration).toContain('grant execute on function public.approve_user_device(text) to authenticated');
  });

  it('stages new device material as pending and inactive', () => {
    expect(serverVerificationMigration).toContain("approval_status = 'pending'");
    expect(serverVerificationMigration).toContain('is_active = false');
    expect(serverVerificationMigration).toContain('device_proof_verification_pending');
    expect(serverVerificationMigration).toContain('device_enrollment_staged');
  });

  it('finalizes only the exact proofs verified by the server', () => {
    expect(serverVerificationMigration).toContain('create or replace function public.finalize_verified_user_device_approval');
    expect(serverVerificationMigration).toContain('v_device.device_public_key is distinct from p_device_public_key');
    expect(serverVerificationMigration).toContain('v_device.device_signing_key is distinct from p_device_signing_key');
    expect(serverVerificationMigration).toContain('v_device.device_authorization_signature is distinct from p_device_authorization_signature');
    expect(serverVerificationMigration).toContain('v_account.identity_binding_signature is distinct from p_account_binding_signature');
    expect(serverVerificationMigration).toContain('challenge.consumed_at is not null');
    expect(serverVerificationMigration).toContain('challenge.cancelled_at is null');
  });

  it('reserves the finalizer to the service role', () => {
    expect(serverVerificationMigration).toContain('from public, anon, authenticated');
    expect(serverVerificationMigration).toContain('to service_role');
    expect(serverVerificationMigration).not.toMatch(
      /grant execute on function public\.finalize_verified_user_device_approval\([\s\S]*?\) to authenticated/,
    );
  });
});
