import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260807010000_identity_rotation_v1.sql',
  'utf8',
);
const edge = readFileSync('supabase/functions/identity-rotation/index.ts', 'utf8');
const client = readFileSync('src/lib/crypto/identityRotation.ts', 'utf8');

describe('account identity rotation v1 architecture', () => {
  it('requires an exact N to N+1 epoch transition', () => {
    expect(migration).toContain('next_epoch = current_epoch + 1');
    expect(migration).toContain('v_current.identity_epoch <> p_current_epoch');
    expect(migration).toContain('v_current.fingerprint <> p_current_fingerprint');
    expect(migration).toContain('identity_rotation_current_identity_changed');
  });

  it('stores one opaque server challenge and a short expiry', () => {
    expect(migration).toContain("interval '10 minutes'");
    expect(migration).toContain('challenge_payload text not null');
    expect(migration).toContain("'protocol', 'forsure-aegis-identity-rotation'");
    expect(migration).toContain('identity_rotation_requests_one_pending_idx');
  });

  it('requires old identity, approved-device and new-binding proofs', () => {
    expect(edge).toContain('IDENTITY_ROTATION_OLD_IDENTITY_PROOF_INVALID');
    expect(edge).toContain('IDENTITY_ROTATION_DEVICE_PROOF_INVALID');
    expect(edge).toContain('IDENTITY_ROTATION_NEW_BINDING_INVALID');
    expect(edge).toContain('IDENTITY_ROTATION_DEVICE_AUTHORIZATION_INVALID');
    expect(edge).toContain('verifyEd25519(current.signing_key');
    expect(edge).toContain('verifyEd25519(device.device_signing_key');
    expect(edge).toContain('validateProposedBinding');
  });

  it('keeps only the device that possesses the new root', () => {
    expect(migration).toContain("revoke_reason = 'account_identity_rotated'");
    expect(migration).toContain('device_id <> p_approver_device_id');
    expect(migration).toContain('other_devices_revoked');
    expect(client).toContain('otherDevicesRevoked: true');
  });

  it('commits the root, device authorization and audit event atomically', () => {
    expect(migration).toContain('update public.user_public_keys');
    expect(migration).toContain('device_authorization_signature = p_current_device_authorization_signature');
    expect(migration).toContain("'identity_rotated'");
    expect(migration).toContain('insert into public.user_identity_change_events');
    expect(migration.trimStart()).toStartWith('begin;');
    expect(migration.trimEnd()).toEndWith('commit;');
  });

  it('exposes rotation RPCs only to service_role', () => {
    for (const functionName of [
      'begin_identity_rotation_v1',
      'commit_identity_rotation_v1',
      'cancel_identity_rotation_v1',
      'get_identity_rotation_status_v1',
    ]) {
      expect(migration).toContain(`public.${functionName}`);
    }
    expect(migration).toContain('from public, anon, authenticated');
    expect(migration).toContain('to service_role');
  });

  it('stages private material before commit and promotes only after confirmation', () => {
    const stageIndex = client.indexOf('await createStage({');
    const commitIndex = client.indexOf("action: 'commit'");
    const promoteIndex = client.indexOf('await promoteStage(user.id');
    expect(stageIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(stageIndex);
    expect(promoteIndex).toBeGreaterThan(commitIndex);
    expect(client).toContain('IDENTITY_ROTATION_COMMITTED_LOCAL_PROMOTION_PENDING');
    expect(client).toContain('recoverPendingIdentityRotation');
  });

  it('never creates a replacement from hydration or background recovery', () => {
    expect(client).toContain('explicit, high-friction user');
    expect(client).not.toContain('setInterval(');
    expect(client).not.toContain('addEventListener(\'online\'');
    expect(client).not.toContain('rotateAccountIdentity(\'');
  });
});
