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
const resetEdgeSource = readFileSync(
  resolve(process.cwd(), 'supabase/functions/identity-reset/index.ts'),
  'utf8',
);
const hardeningMigrationSource = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260930002834_harden_identity_and_device_enrollment.sql',
  ),
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
    expect(resetSource).toContain("functions.invoke('identity-reset'");
    expect(resetEdgeSource).toContain('signInWithPassword');
    expect(resetEdgeSource).toContain('passwordData.user?.id !== caller.id');
  });

  it('generates private identity material only on the client', () => {
    expect(resetSource).toContain('generateIdentityKeys()');
    expect(resetSource).not.toContain("rpc('generate");
    expect(resetEdgeSource).not.toContain('generateIdentityKeys');
    expect(resetEdgeSource).not.toContain('saveIdentityKeys');
  });

  it('swaps the public identity atomically server-side and never deletes it', () => {
    expect(resetEdgeSource).toContain("rpc('replace_unrecoverable_identity_v2'");
    expect(hardeningMigrationSource).toContain('create or replace function public.replace_unrecoverable_identity_v2');
    expect(resetSource).not.toContain(".delete()");
  });

  it('removes browser writes and the bearer-token-only legacy reset path', () => {
    expect(hardeningMigrationSource).toContain('revoke insert, update, delete, truncate');
    expect(hardeningMigrationSource).toContain('aegis_guard_account_identity_mutation_v2');
    expect(hardeningMigrationSource).toContain('from public, anon, authenticated, service_role');
    expect(resetSource).not.toContain("rpc('replace_own_identity_key'");
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
