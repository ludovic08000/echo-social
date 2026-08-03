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
    expect(pin).not.toContain("supabase.rpc('has_backup_pin'");
    expect(pin).not.toContain('setupPersistentBackupPin');
    expect(pin).not.toContain('restoreWithBackupPin');
    expect(pin).toContain('const localIdentity = await loadIdentityKeys');
    expect(pin).not.toContain('initial server backup deferred');
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
    const localCommit = banner.indexOf('saveKnownFingerprint(observerUserId, peerUserId, latest.newFingerprint)');
    const ledgerCommit = banner.indexOf('await acknowledgeAllForPeer(observerUserId, peerUserId)');
    expect(serverCommit).toBeGreaterThan(-1);
    expect(localCommit).toBeGreaterThan(serverCommit);
    expect(ledgerCommit).toBeGreaterThan(localCommit);
    expect(banner).toContain('FINGERPRINT_ACK_PERSISTENCE_FAILED');
    expect(banner).toContain("reason: 'fingerprint_acknowledged_by_user'");
    expect(tracker).toContain('): Promise<boolean>');
    expect(tracker).toContain('confirms the');
    expect(tracker).toContain('exact account fingerprint currently displayed');
    expect(tracker).toContain('previousFingerprint && previousFingerprint !== currentFingerprint');
    expect(tracker).not.toContain('MANUAL_TRUST_CONTACTS_KEY');
    expect(tracker).not.toContain('isManuallyTrustedContact');
    expect(tracker).not.toContain('future key rotations update the observed');
    expect(tracker).toContain('return false;');
  });

  it('quarantines invalid historical devices while retaining verified routes', () => {
    const registry = source('src/e2ee-session/deviceRegistry.ts');
    expect(registry).toContain('trustedRoutable');
    expect(registry).toContain('rejectedRoutable');
    expect(registry).toContain('quarantining invalid historical device authorizations');
    expect(registry).toContain("throw new Error('E2EE_DEVICE_REGISTRY_INVALID')");
    expect(registry).toContain('refusing raw fallback');
  });

  it('does not generate a Master Key from sync or PIN setup fallback paths', () => {
    const accountBackup = source('src/lib/crypto/accountKeyBackup.ts');
    expect(accountBackup).toContain('runAccountKeyInitSingleFlight');
    expect(accountBackup).toContain('hasLocalAccountIdentity');
    expect(accountBackup).toContain('decideMasterKeyCreation');
    expect(accountBackup).toContain('row?.id === userId');
    expect(accountBackup).toContain("backupUserId !== userId");
    expect(accountBackup).toContain('Sync refused: authoritative account Master Key session is unavailable');
    expect(accountBackup).not.toContain('pin_wrap_master');
    expect(accountBackup).not.toContain('release_backup_pin_blob');
  });

  it('never mistakes orphan Ratchet state for a recoverable account identity', () => {
    const accountBackup = source('src/lib/crypto/accountKeyBackup.ts');
    const identityProbeStart = accountBackup.indexOf('export async function hasLocalKeys');
    const digestStart = accountBackup.indexOf('export async function computeLocalCryptoDigest');
    const identityProbe = accountBackup.slice(identityProbeStart, digestStart);
    const sync = source('src/hooks/useAccountKeySync.ts');

    expect(identityProbe).toContain('loadIdentityKeys(userId)');
    expect(identityProbe).toContain('hasWrappedKeys(userId)');
    expect(identityProbe).not.toContain("countSideDB('forsure-ratchet'");
    expect(sync).toContain('hasLocalKeys(user.id)');
  });

  it('always scopes restored-session checks to the signed-in account and catches bootstrap pauses', () => {
    const auth = source('src/lib/auth.tsx');
    const dialog = source('src/components/messages/E2EERestorePromptDialog.tsx');
    const bootstrap = source('src/lib/crypto/identityBootstrap.ts');

    expect(auth).toContain('hasLocalKeys(userId)');
    expect(dialog).toContain('hasLocalKeys(user.id)');
    expect(dialog).toContain("reason: 'server_identity_without_local_identity'");
    expect(dialog).toContain(".from('user_public_keys')");
    expect(bootstrap).toContain('error instanceof PinUnlockRequiredError');
    expect(bootstrap).toContain('runWithoutUnhandledRejection(userId)');
  });

  it('does not reuse a stale peer key after a failed forced refresh', () => {
    const peerCache = source('src/lib/crypto/peerKeyCache.ts');
    expect(peerCache).toContain("if (options?.forceRefresh) _peerKeyCache.delete(peerUserId)");
  });
});
