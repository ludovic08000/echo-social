import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('temporary Lovable Cloud device crypto bridges', () => {
  it('routes approval and binding through typed RPCs only', () => {
    const approval = read('src/lib/crypto/deviceApprovalDecision.ts');
    const binding = read('src/lib/crypto/deviceAccountBinding.ts');
    expect(approval).toContain('rpcApproveDeviceEnrollmentDecision');
    expect(binding).toContain('rpcBindDeviceAccount');
    expect(approval).not.toContain("functions.invoke('approve-device-enrollment'");
    expect(binding).not.toContain("functions.invoke('approve-device-enrollment'");
  });

  it('versions server-side Ed25519 verification and keeps finalizers private', () => {
    const sql = read('supabase/migrations/20260809190000_temporary_device_crypto_bridges.sql');
    expect(sql).toContain('aegis_private.verify_ed25519_b64');
    expect(sql).toContain('create or replace function public.approve_device_enrollment_decision');
    expect(sql).toContain('create or replace function public.bind_device_account');
    expect(sql).toContain("DEVICE_AUTHORIZATION_SIGNATURE_INVALID");
    expect(sql).toContain('revoke all on function public.bind_device_account(text,text) from public, anon');
    expect(sql).toContain('grant execute on function public.bind_device_account(text,text) to authenticated, service_role');
    expect(sql).not.toContain('grant execute on function public.finalize_device_account_binding');
  });
});
