import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('recovery-key-only E2EE vault policy', () => {
  it('keeps chat PIN verification local and removes server restore calls', () => {
    const pin = source('../../../hooks/useChatPin.ts');
    expect(pin).not.toContain('restoreWithBackupPin');
    expect(pin).not.toContain('setupPersistentBackupPin');
    expect(pin).not.toContain('hasBackupPin');
    expect(pin).toContain('PIN local indisponible');
  });

  it('does not use the account password as an E2EE recovery secret', () => {
    const auth = source('../../auth.tsx');
    expect(auth).not.toContain('initializeArchiveMasterKeyFromPassword');
    expect(auth).toContain("ensureBackupIndexedFromR2(userId, 'recovery')");
    const account = source('../accountKeyBackup.ts');
    expect(account).toContain('RECOVERY_KEY_ONLY_VAULT = true');
    expect(account).toContain("backup_type', 'recovery'");
    expect(account).toContain('_sessionRecoverySecret');
  });

  it('blocks weak Supabase and R2 backup formats', () => {
    const migration = source('../../../../supabase/migrations/20260729234500_recovery_key_only_e2ee_vault.sql');
    expect(migration).toContain('E2EE_RECOVERY_KEY_REQUIRED');
    expect(migration).toContain('SERVER_PIN_BACKUP_DISABLED');
    expect(migration).toContain("delete from public.user_backups where backup_type = 'account'");
    const edge = source('../../../../supabase/functions/e2ee-backup-vault/index.ts');
    expect(edge).toContain("backupType === 'account' && action !== 'delete'");
  });
});
