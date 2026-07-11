import { supabase } from '@/integrations/supabase/client';

export interface EncryptedAccountBackupEnvelope {
  encrypted_blob: string;
  iv: string;
  salt: string;
  wrapped_master_key: string;
  master_key_iv: string;
  version: number;
  backup_type: 'account' | 'recovery';
  created_at: string;
}

function isEnvelope(value: unknown): value is EncryptedAccountBackupEnvelope {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.encrypted_blob === 'string' && row.encrypted_blob.length > 0 &&
    typeof row.iv === 'string' && row.iv.length > 0 &&
    typeof row.salt === 'string' && row.salt.length > 0 &&
    typeof row.wrapped_master_key === 'string' && row.wrapped_master_key.length > 0 &&
    typeof row.master_key_iv === 'string' && row.master_key_iv.length > 0 &&
    Number.isInteger(row.version) && Number(row.version) > 0 &&
    (row.backup_type === 'account' || row.backup_type === 'recovery') &&
    typeof row.created_at === 'string' && !Number.isNaN(Date.parse(row.created_at))
  );
}

async function readLocalBackup(
  userId: string,
  backupType: 'account' | 'recovery' = 'account',
): Promise<EncryptedAccountBackupEnvelope | null> {
  try {
    const { data, error } = await supabase
      .from('user_backups' as any)
      .select('encrypted_blob, iv, salt, wrapped_master_key, master_key_iv, version, backup_type, created_at')
      .eq('user_id', userId)
      .eq('backup_type', backupType)
      .maybeSingle();
    if (error || !isEnvelope(data)) return null;
    return data;
  } catch {
    return null;
  }
}

/** Mirror the already-encrypted Supabase backup into the private R2 vault. */
export async function mirrorCurrentBackupToR2(
  userId: string,
  backupType: 'account' | 'recovery' = 'account',
): Promise<boolean> {
  if (!userId) return false;
  const backup = await readLocalBackup(userId, backupType);
  if (!backup) return false;

  try {
    const { data, error } = await supabase.functions.invoke('e2ee-backup-vault', {
      body: {
        action: 'put',
        backup_type: backupType,
        backup,
      },
    });
    return !error && data?.ok === true;
  } catch {
    return false;
  }
}

/**
 * If the hot Supabase backup row is missing, recover its encrypted envelope
 * from R2 and re-index it. No plaintext or unwrapped key crosses the network.
 */
export async function ensureBackupIndexedFromR2(
  userId: string,
  backupType: 'account' | 'recovery' = 'account',
): Promise<'present' | 'restored' | 'missing' | 'unavailable'> {
  if (!userId) return 'unavailable';

  const existing = await readLocalBackup(userId, backupType);
  if (existing) return 'present';

  try {
    const { data, error } = await supabase.functions.invoke('e2ee-backup-vault', {
      body: { action: 'get', backup_type: backupType },
    });
    if (error) return 'unavailable';
    if (!data?.found) return 'missing';
    if (!isEnvelope(data.backup) || data.backup.backup_type !== backupType) {
      return 'unavailable';
    }

    const backup = data.backup as EncryptedAccountBackupEnvelope;
    const { error: restoreError } = await supabase
      .from('user_backups' as any)
      .upsert({
        user_id: userId,
        ...backup,
      }, { onConflict: 'user_id,backup_type' });
    if (restoreError) return 'unavailable';

    return 'restored';
  } catch {
    return 'unavailable';
  }
}

export async function deleteBackupMirrorFromR2(
  backupType: 'account' | 'recovery' = 'account',
): Promise<boolean> {
  try {
    const { data, error } = await supabase.functions.invoke('e2ee-backup-vault', {
      body: { action: 'delete', backup_type: backupType },
    });
    return !error && data?.ok === true;
  } catch {
    return false;
  }
}
