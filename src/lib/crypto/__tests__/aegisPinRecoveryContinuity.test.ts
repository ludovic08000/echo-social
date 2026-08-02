import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('Aegis PIN recovery and identity continuity', () => {
  it('never creates a replacement account identity from the safe recovery wrapper', () => {
    const safeManager = source('src/lib/crypto/keyManagerSafe.ts');
    expect(safeManager).not.toContain('generateIdentityKeys');
    expect(safeManager).not.toContain('saveIdentityKeys');
    expect(safeManager).not.toContain('createReplacementIdentity');
    expect(safeManager).toContain('throw new PinUnlockRequiredError');
    expect(safeManager).toContain('forsure:e2ee-restore-needed');
  });

  it('propagates recovery failure instead of generating a new epoch locally', () => {
    const recovery = source('src/lib/crypto/identityRecovery.ts');
    expect(recovery).not.toContain('generateIdentityKeys');
    expect(recovery).not.toContain('saveIdentityKeys');
    expect(recovery).toContain('throw error');
    expect(recovery).toContain("mode: keys.isNewIdentity === true");
  });

  it('treats an unavailable continuity inspection as unsafe for PIN creation', () => {
    const pin = source('src/hooks/useChatPin.ts');
    expect(pin).toContain('inspectServerContinuity');
    expect(pin).toContain('inspection_unavailable');
    expect(pin).toContain('Aucun nouveau PIN n’a été créé');
    expect(pin).toContain(".from('user_public_keys')");
    expect(pin).toContain(".from('user_backups')");
    expect(pin).toContain("supabase.rpc('has_backup_pin'");
  });

  it('initializes the account Master Key session independently of archive status', () => {
    const auth = source('src/lib/auth.tsx');
    const accountInit = auth.indexOf('const accountStatus = await initAccountKeySync(password, userId)');
    const archiveBlocked = auth.indexOf("if (archiveStatus === 'blocked')");
    expect(accountInit).toBeGreaterThan(-1);
    expect(archiveBlocked).toBeGreaterThan(accountInit);
    expect(auth).toContain("status: 'restored_from_password_sign_in'");
  });

  it('makes an explicit safety-number acknowledgement authoritative for sending', () => {
    const banner = source('src/components/messages/IdentityChangeBanner.tsx');
    expect(banner).toContain('saveKnownFingerprint(peerUserId, latest.newFingerprint)');
    expect(banner).toContain('saveKnownFingerprintServer(peerUserId, latest.newFingerprint, true)');
    expect(banner).toContain("reason: 'fingerprint_acknowledged_by_user'");
  });

  it('quarantines invalid historical devices while retaining verified routes', () => {
    const registry = source('src/e2ee-session/deviceRegistry.ts');
    expect(registry).toContain('trustedRoutable');
    expect(registry).toContain('quarantining invalid device authorizations');
    expect(registry).toContain("throw new Error('E2EE_DEVICE_REGISTRY_INVALID')");
    expect(registry).toContain('refusing raw fallback');
  });
});
