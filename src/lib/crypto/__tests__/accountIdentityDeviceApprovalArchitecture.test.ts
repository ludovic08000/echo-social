import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const client = readFileSync('src/lib/crypto/deviceApprovalDecision.ts', 'utf8');
const recoveryFunction = readFileSync(
  'supabase/functions/recover-device-enrollment/index.ts',
  'utf8',
);
const recoveryMigration = readFileSync(
  'supabase/migrations/20260806213000_allow_recovery_and_first_device_approval.sql',
  'utf8',
);
const gate = readFileSync('src/components/security/PendingDeviceApprovalGate.tsx', 'utf8');
const restoreDialog = readFileSync(
  'src/components/messages/E2EERestorePromptDialog.tsx',
  'utf8',
);

describe('account identity device approval architecture', () => {
  it('supports recovery without naming or requiring a Windows installation', () => {
    expect(gate).toContain('Depuis un autre appareil déjà approuvé');
    expect(gate).toContain('Récupérer ce compte');
    expect(gate).not.toContain('À faire sur votre Windows');
    expect(gate).not.toContain('par exemple votre Windows');
    expect(client).toContain("AccountIdentityApprovalMode = 'account_recovery'");
    expect(client).toContain("functions.invoke('recover-device-enrollment'");
  });

  it('requires the stable account private key to sign the exact pending target', () => {
    expect(client).toContain("protocol: 'forsure-aegis-account-device-recovery-approval'");
    expect(client).toContain('accountIdentity.signingPrivateKey');
    expect(client).toContain('targetChallengeId: args.target.challengeId');
    expect(client).toContain('targetDevicePublicKey: args.target.devicePublicKey');
    expect(client).toContain('targetDeviceSigningKey: args.target.deviceSigningKey');
    expect(recoveryFunction).toContain('ACCOUNT_RECOVERY_SIGNATURE_INVALID');
    expect(recoveryFunction).toContain('DEVICE_AUTHORIZATION_SIGNATURE_INVALID');
    expect(recoveryFunction).toContain('DEVICE_POSSESSION_SIGNATURE_INVALID');
  });

  it('allows exactly one first-device bootstrap for a genuinely new account', () => {
    expect(client).toContain("'first_device_bootstrap'");
    expect(recoveryFunction).toContain('FIRST_DEVICE_ACCOUNT_ALREADY_INITIALIZED');
    expect(recoveryFunction).toContain('FIRST_DEVICE_BOOTSTRAP_FORBIDDEN');
    expect(recoveryFunction).toContain('finalize_verified_first_user_device');
    expect(recoveryMigration).toContain("approval_method = 'first_device_bootstrap'");
    expect(recoveryMigration).toContain('device.device_id <> v_device_id');
    expect(gate).toContain('Activer ce premier appareil');
  });

  it('allows explicit recovery on pending devices but blocks automatic recovery prompts', () => {
    expect(gate).toContain('allowPendingDeviceRecovery: true');
    expect(gate).toContain("window.addEventListener('forsure-keys-restored'");
    expect(restoreDialog).toContain('detail.allowPendingDeviceRecovery === true');
    expect(restoreDialog).toContain('pendingDeviceRecovery');
    expect(restoreDialog).toContain('explicitly');
    expect(restoreDialog).toContain('Aucune sauvegarde ne permet de prouver cette identité');
  });

  it('keeps all approval finalizers service-role only', () => {
    expect(recoveryMigration).toContain('finalize_verified_user_device_approval_from_recovery');
    expect(recoveryMigration).toContain('finalize_verified_first_user_device');
    expect(recoveryMigration).toContain('to service_role');
    expect(recoveryMigration).toContain('from public, anon, authenticated');
  });
});
