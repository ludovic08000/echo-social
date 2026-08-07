import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260807010000_identity_rotation_v1.sql',
  'utf8',
);
const downgradeGuard = readFileSync(
  'supabase/migrations/20260807010500_identity_rotation_downgrade_guard.sql',
  'utf8',
);
const recoveryMigration = readFileSync(
  'supabase/migrations/20260807011000_identity_rotation_recovery_vault.sql',
  'utf8',
);
const alignmentMigration = readFileSync(
  'supabase/migrations/20260807011500_identity_rotation_state_alignment.sql',
  'utf8',
);
const edge = readFileSync('supabase/functions/identity-rotation/index.ts', 'utf8');
const recoveryEdge = readFileSync(
  'supabase/functions/identity-rotation-recovery/index.ts',
  'utf8',
);
const client = readFileSync('src/lib/crypto/identityRotation.ts', 'utf8');
const recoveryClient = readFileSync(
  'src/lib/crypto/identityRotationRecovery.ts',
  'utf8',
);
const rotationPanel = readFileSync(
  'src/components/settings/IdentityRotationPanel.tsx',
  'utf8',
);
const settingsPage = readFileSync('src/pages/Settings.tsx', 'utf8');

describe('account identity rotation v1 architecture', () => {
  it('requires an exact N to N+1 epoch transition', () => {
    expect(migration).toContain('next_epoch = current_epoch + 1');
    expect(migration).toContain('v_current.identity_epoch <> p_current_epoch');
    expect(migration).toContain('v_current.fingerprint <> p_current_fingerprint');
    expect(migration).toContain('identity_rotation_current_identity_changed');
  });

  it('stores one exact server challenge with a short expiry', () => {
    expect(migration).toContain("interval '10 minutes'");
    expect(migration).toContain('challenge_payload text not null');
    expect(migration).toContain("'protocol', 'forsure-aegis-identity-rotation'");
    expect(migration).toContain('identity_rotation_requests_one_pending_idx');
  });

  it('requires the old root, its authorized device and the proposed root', () => {
    expect(edge).toContain('IDENTITY_ROTATION_CURRENT_AUTHORITY_INVALID');
    expect(edge).toContain('IDENTITY_ROTATION_OLD_IDENTITY_PROOF_INVALID');
    expect(edge).toContain('IDENTITY_ROTATION_DEVICE_PROOF_INVALID');
    expect(edge).toContain('IDENTITY_ROTATION_NEW_BINDING_INVALID');
    expect(edge).toContain('IDENTITY_ROTATION_DEVICE_AUTHORIZATION_INVALID');
    expect(edge).toContain('validateCurrentAuthority');
    expect(edge).toContain('verifyEd25519(current.signing_key');
    expect(edge).toContain('verifyEd25519(device.device_signing_key');
    expect(edge).toContain('validateIdentityBinding');
    expect(edge).toContain('device.device_authorization_signature');
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
    expect(migration.trimStart().startsWith('begin;')).toBe(true);
    expect(migration.trimEnd().endsWith('commit;')).toBe(true);
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

  it('blocks direct root lifecycle changes but preserves same-root upserts', () => {
    expect(downgradeGuard).toContain('security invoker');
    expect(downgradeGuard).toContain("current_user in ('anon', 'authenticated')");
    expect(downgradeGuard).toContain('identity_rotation_verified_flow_required');
    expect(downgradeGuard).toContain('new.identity_epoch := v_active.identity_epoch');
    expect(downgradeGuard).toContain('new.identity_epoch is distinct from old.identity_epoch');
    expect(downgradeGuard).toContain('new.is_active is distinct from old.is_active');
    expect(downgradeGuard).toContain('create trigger guard_account_identity_rotation_v1');
    expect(downgradeGuard).toContain('create trigger guard_account_identity_deletion_v1');
    expect(downgradeGuard).toContain("if tg_op = 'DELETE'");
  });

  it('requires immutable encrypted recovery before server commit', () => {
    expect(recoveryMigration).toContain('recovery_blob text');
    expect(recoveryMigration).toContain('create trigger require_identity_rotation_recovery_v1');
    expect(recoveryMigration).toContain('identity_rotation_recovery_required');
    expect(recoveryMigration).toContain('identity_rotation_recovery_already_attached');
    expect(recoveryMigration).toContain('to service_role');
    expect(recoveryEdge).toContain("'attach', 'fetch', 'finalize'");
    expect(recoveryEdge).not.toContain('console.log');
  });

  it('binds every recovery-vault action to the surviving device key', () => {
    expect(recoveryEdge).toContain('IDENTITY_ROTATION_RECOVERY_DEVICE_MISMATCH');
    expect(recoveryEdge).toContain('IDENTITY_ROTATION_RECOVERY_DEVICE_NOT_TRUSTED');
    expect(recoveryEdge).toContain('IDENTITY_ROTATION_RECOVERY_DEVICE_PROOF_INVALID');
    expect(recoveryEdge).toContain('row.approver_device_id !== deviceId');
    expect(recoveryEdge).toContain('proofTimeValid');
    expect(recoveryEdge).toContain('verifyEd25519(');
    expect(recoveryClient).toContain('createAccessProof');
    expect(recoveryClient).toContain('loadDeviceIdentity');
    expect(recoveryClient).toContain('proof_signature');
  });

  it('encrypts the staged root under the unlocked account Master Key', () => {
    expect(recoveryClient).toContain('getSessionMasterKey');
    expect(recoveryClient).toContain("name: 'AES-GCM'");
    expect(recoveryClient).toContain('forsure-aegis-identity-rotation-recovery-v1');
    expect(recoveryClient).toContain('additionalData: recoveryAAD');
  });

  it('attaches recovery before commit and promotes only after confirmation', () => {
    const stageIndex = client.indexOf('await createStage({');
    const recoveryIndex = client.indexOf('await attachIdentityRotationRecovery(staged);');
    const commitIndex = client.indexOf("action: 'commit'");
    const promoteIndex = client.indexOf('await promoteStage(user.id');
    expect(stageIndex).toBeGreaterThan(-1);
    expect(recoveryIndex).toBeGreaterThan(stageIndex);
    expect(commitIndex).toBeGreaterThan(recoveryIndex);
    expect(promoteIndex).toBeGreaterThan(commitIndex);
    expect(client).toContain('IDENTITY_ROTATION_COMMITTED_LOCAL_PROMOTION_PENDING');
    expect(client).toContain('fetchIdentityRotationRecovery');
  });

  it('backs up the promoted root before discarding recovery material', () => {
    const saveIndex = client.indexOf('await saveIdentityKeys(userId, staged.keys);');
    const backupIndex = client.indexOf('await syncBackupToServer();');
    const spkIndex = client.indexOf('await generateAndUploadDeviceSignedPrekey(');
    const ratchetIndex = client.indexOf('await clearAllDeviceSessions();');
    const finalizeIndex = client.indexOf('await finalizeIdentityRotationRecovery');
    expect(saveIndex).toBeGreaterThan(-1);
    expect(backupIndex).toBeGreaterThan(saveIndex);
    expect(spkIndex).toBeGreaterThan(backupIndex);
    expect(ratchetIndex).toBeGreaterThan(spkIndex);
    expect(finalizeIndex).toBeGreaterThan(ratchetIndex);
    expect(client).toContain('IDENTITY_ROTATION_BACKUP_SYNC_REQUIRED');
  });

  it('aligns every derived account-identity registry', () => {
    expect(alignmentMigration).toContain('insert into public.user_crypto_state');
    expect(alignmentMigration).toContain('insert into public.user_identity_roots');
    expect(alignmentMigration).toContain('create trigger sync_active_account_identity_v1');
    expect(alignmentMigration).toContain('create trigger sync_identity_root_primary_device_v1');
    expect(alignmentMigration).toContain('greatest(generation, new.identity_epoch)');
  });

  it('exposes only an explicit PIN-gated destructive UI action', () => {
    expect(settingsPage).toContain('<MessagingPinGate>');
    expect(settingsPage).toContain('<IdentityRotationPanel />');
    expect(rotationPanel).toContain('RÉVOQUER LES AUTRES APPAREILS');
    expect(rotationPanel).toContain("rotateAccountIdentity('manual_rotation')");
    expect(rotationPanel).toContain('disabled={rotating || recovering || pending}');
    expect(rotationPanel).toContain('Reprendre la finalisation');
  });

  it('never creates a replacement from hydration or background recovery', () => {
    expect(client).toContain('explicit, high-friction user');
    expect(client).not.toContain('setInterval(');
    expect(client).not.toContain("addEventListener('online'");
    expect(client).not.toContain("rotateAccountIdentity('");
  });
});
