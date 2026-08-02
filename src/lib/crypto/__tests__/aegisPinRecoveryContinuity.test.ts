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

  it('initializes the account Master Key even when R2 or archive initialization fails', () => {
    const auth = source('src/lib/auth.tsx');
    const r2FailureBoundary = auth.indexOf('R2 backup index unavailable; continuing with account backup');
    const accountInit = auth.indexOf('accountStatus = await initAccountKeySync(password, userId)');
    const archiveInit = auth.indexOf('archiveStatus = await initializeArchiveMasterKeyFromPassword(password, userId)');
    const archiveBlocked = auth.indexOf("if (archiveStatus === 'blocked')");
    expect(r2FailureBoundary).toBeGreaterThan(-1);
    expect(accountInit).toBeGreaterThan(r2FailureBoundary);
    expect(archiveInit).toBeGreaterThan(accountInit);
    expect(archiveBlocked).toBeGreaterThan(archiveInit);
    expect(auth).toContain("status: 'restored_from_password_sign_in'");
  });

  it('commits an explicit safety-number acknowledgement before enabling sending', () => {
    const banner = source('src/components/messages/IdentityChangeBanner.tsx');
    const tracker = source('src/lib/crypto/fingerprintTracker.ts');
    const serverCommit = banner.indexOf('const persisted = await saveKnownFingerprintServer');
    const localCommit = banner.indexOf('saveKnownFingerprint(peerUserId, latest.newFingerprint)');
    const ledgerCommit = banner.indexOf('await acknowledgeAllForPeer(observerUserId, peerUserId)');
    expect(serverCommit).toBeGreaterThan(-1);
    expect(localCommit).toBeGreaterThan(serverCommit);
    expect(ledgerCommit).toBeGreaterThan(localCommit);
    expect(banner).toContain('FINGERPRINT_ACK_PERSISTENCE_FAILED');
    expect(banner).toContain("reason: 'fingerprint_acknowledged_by_user'");
    expect(tracker).toContain('): Promise<boolean>');
    expect(tracker).toContain('return false;');
  });

  it('quarantines invalid historical devices while retaining verified routes', () => {
    const registry = source('src/e2ee-session/deviceRegistry.ts');
    expect(registry).toContain('trustedRoutable');
    expect(registry).toContain('quarantining invalid device authorizations');
    expect(registry).toContain("throw new Error('E2EE_DEVICE_REGISTRY_INVALID')");
    expect(registry).toContain('refusing raw fallback');
  });
});
