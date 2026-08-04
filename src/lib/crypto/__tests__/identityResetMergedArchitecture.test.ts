import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const stateSource = readFileSync(
  resolve(process.cwd(), 'src/lib/crypto/accountCryptoState.ts'),
  'utf8',
);
const resetSource = readFileSync(
  resolve(process.cwd(), 'src/lib/crypto/explicitIdentityReset.ts'),
  'utf8',
);
const gateSource = readFileSync(
  resolve(process.cwd(), 'src/components/messaging/IdentityRecoveryGate.tsx'),
  'utf8',
);
const coordinatorSource = readFileSync(
  resolve(process.cwd(), 'src/lib/crypto/recoveryDialogCoordinator.ts'),
  'utf8',
);

describe('merged explicit identity reset architecture', () => {
  it('keeps account-state inspection read-only and independent from message history', () => {
    expect(stateSource).not.toContain('generateIdentityKeys');
    expect(stateSource).not.toContain('saveIdentityKeys');
    expect(stateSource).not.toContain(".insert(");
    expect(stateSource).not.toContain(".update(");
    expect(stateSource).not.toContain(".delete(");
    expect(stateSource).not.toContain("from('messages'");
    expect(stateSource).not.toContain("from('conversations'");
  });

  it('permits reset only for an unrecoverable server identity', () => {
    expect(resetSource).toContain("before.state !== 'UNRECOVERABLE_SERVER_IDENTITY'");
    expect(resetSource).toContain('before.hasRestorableBackup');
    expect(resetSource).toContain('signInWithPassword');
  });

  it('generates private identity material only on the client', () => {
    expect(resetSource).toContain('generateIdentityKeys()');
    expect(resetSource).not.toContain("rpc('generate");
    expect(resetSource).not.toContain('functions.invoke');
  });

  it('archives the previous public identity instead of deleting it', () => {
    expect(resetSource).toContain('is_active: false');
    expect(resetSource).not.toContain(".delete()");
  });

  it('requires backup creation and a READY reinspection before success', () => {
    expect(resetSource).toContain('initAccountKeySync(password, user.id)');
    expect(resetSource).toContain("after.state !== 'READY'");
    expect(resetSource).toContain('!after.hasAccountBackup');
  });

  it('prevents double reset execution with a single-flight guard', () => {
    expect(resetSource).toContain('let inFlight');
    expect(resetSource).toContain("fail('already_running')");
  });

  it('keeps reset behind the dedicated recovery gate and confirmation UI', () => {
    expect(gateSource).toContain('resetUnrecoverableIdentityWithPassword');
    expect(gateSource).toContain('UNRECOVERABLE_SERVER_IDENTITY');
    expect(gateSource).toContain('Créer une nouvelle identité sécurisée');
  });

  it('centralizes recovery-dialog ownership', () => {
    expect(coordinatorSource).toContain('acquireRecoveryDialog');
    expect(coordinatorSource).toContain('releaseRecoveryDialog');
  });
});
