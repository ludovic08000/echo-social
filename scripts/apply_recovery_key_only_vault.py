from pathlib import Path
import re


def write(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content.strip() + '\n', encoding='utf-8')


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    source = target.read_text(encoding='utf-8-sig')
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 occurrence, found {count}')
    target.write_text(source.replace(old, new, 1), encoding='utf-8')


def regex_once(path: str, pattern: str, replacement: str, label: str) -> None:
    target = Path(path)
    source = target.read_text(encoding='utf-8-sig')
    updated, count = re.subn(pattern, replacement, source, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 occurrence, found {count}')
    target.write_text(updated, encoding='utf-8')


# ---------------------------------------------------------------------------
# Account vault: no password/PIN server recovery. Recovery key is 256-bit and
# remains in memory or native secure storage only.
# ---------------------------------------------------------------------------
replace_once(
    'src/lib/crypto/accountKeyBackup.ts',
    "const KEYCHAIN_SNAPSHOT_PREFIX = 'forsure-e2ee-keychain-snapshot-v1:';\n",
    "const KEYCHAIN_SNAPSHOT_PREFIX = 'forsure-e2ee-keychain-snapshot-v1:';\nconst RECOVERY_SECRET_PREFIX = 'forsure-e2ee-recovery-secret-v1:';\nexport const RECOVERY_KEY_ONLY_VAULT = true;\n",
    'account vault strict constants',
)
replace_once(
    'src/lib/crypto/accountKeyBackup.ts',
    "let _sessionPassword: string | null = null;\nlet _sessionUserId: string | null = null;\n",
    "let _sessionPassword: string | null = null; // legacy field, never used for server recovery\nlet _sessionRecoverySecret: string | null = null;\nlet _sessionUserId: string | null = null;\n",
    'account vault recovery session state',
)
replace_once(
    'src/lib/crypto/accountKeyBackup.ts',
    "function generateMasterKey(): Uint8Array {\n  return hardCrypto.getRandomValues(new Uint8Array(MASTER_KEY_LENGTH));\n}\n",
    r'''function generateMasterKey(): Uint8Array {
  return hardCrypto.getRandomValues(new Uint8Array(MASTER_KEY_LENGTH));
}

async function persistRecoverySecretLocally(userId: string, normalizedRecoveryKey: string): Promise<void> {
  _sessionRecoverySecret = recoverySecret(normalizedRecoveryKey, userId);
  _sessionUserId = userId;
  await secureSetSecret(`${RECOVERY_SECRET_PREFIX}${userId}`, normalizedRecoveryKey).catch(() => false);
}

async function loadRecoverySecretFromNative(userId: string): Promise<string | null> {
  const stored = await secureGetSecret(`${RECOVERY_SECRET_PREFIX}${userId}`).catch(() => null);
  if (!stored) return null;
  const { isValidRecoveryKey, normalizeRecoveryKey } = await import('@/lib/crypto/recoveryKey');
  if (!isValidRecoveryKey(stored)) return null;
  const normalized = normalizeRecoveryKey(stored);
  _sessionRecoverySecret = recoverySecret(normalized, userId);
  _sessionUserId = userId;
  return _sessionRecoverySecret;
}

async function ensureStrictSessionMasterKey(userId: string): Promise<boolean> {
  if (_sessionMasterKey && _sessionRawMasterKey && _sessionUserId === userId) return true;
  if (!(await hasLocalKeys())) return false;

  const archive = await import('@/lib/crypto/archiveMasterKey');
  const existing = await archive.exportArchiveMasterKeyForDeviceLink(userId).catch(() => null);
  let raw: Uint8Array;
  if (existing) {
    raw = new Uint8Array(base64ToBuffer(existing));
    if (raw.byteLength !== MASTER_KEY_LENGTH) return false;
  } else {
    raw = generateMasterKey();
    await archive.importArchiveMasterKeyFromDeviceLink(
      bufferToBase64(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer),
      userId,
    );
  }
  _sessionRawMasterKey = raw.slice();
  _sessionMasterKey = await importMasterKey(raw);
  _sessionUserId = userId;
  _sessionPassword = null;
  dispatchSessionUnlocked(userId);
  raw.fill(0);
  return true;
}

async function purgeWeakServerBackups(userId: string): Promise<void> {
  await Promise.allSettled([
    supabase.from('user_backups' as any).delete().eq('user_id', userId).eq('backup_type', 'account'),
    supabase.from('backup_pin_state' as any).delete().eq('user_id', userId),
    import('@/lib/crypto/r2BackupVault').then(({ deleteBackupMirrorFromR2 }) =>
      deleteBackupMirrorFromR2('account')),
  ]);
}
''',
    'account vault strict helpers',
)

regex_once(
    'src/lib/crypto/accountKeyBackup.ts',
    r"export async function initAccountKeySync\(password: string, userId: string\): Promise<'restored' \| 'local_ok' \| 'no_backup' \| 'error'> \{.*?\n\}\n\n/\*\*\n \* Re-attempt restore",
    r'''export async function initAccountKeySync(
  _password: string,
  userId: string,
): Promise<'restored' | 'local_ok' | 'no_backup' | 'error'> {
  try {
    _sessionPassword = null;
    _sessionUserId = userId;
    await purgeWeakServerBackups(userId);
    await loadRecoverySecretFromNative(userId);

    if (await hasLocalKeys()) {
      await ensureStrictSessionMasterKey(userId);
      await writeKeychainSnapshot(userId);
      return 'local_ok';
    }

    const keychainStatus = await restoreKeysFromKeychainSnapshot(userId);
    if (keychainStatus === 'restored') {
      await ensureStrictSessionMasterKey(userId);
      return 'restored';
    }

    // A server backup is intentionally unusable without the 256-bit recovery
    // key. Authentication success alone never restores E2EE material.
    return 'no_backup';
  } catch (error) {
    logCryptoException('backup', error, {
      severity: 'error',
      metadata: { stage: 'strict_recovery_init', userId },
    });
    return 'error';
  }
}

/**
 * Re-attempt restore''',
    'replace password account initialization',
)

regex_once(
    'src/lib/crypto/accountKeyBackup.ts',
    r"export async function restoreAccountKeysFromActiveSession\(userId\?: string\): Promise<'restored' \| 'local_ok' \| 'unavailable' \| 'error'> \{.*?\n\}\n\n/\*\*\n \* Silent re-hydration",
    r'''export async function restoreAccountKeysFromActiveSession(
  userId?: string,
): Promise<'restored' | 'local_ok' | 'unavailable' | 'error'> {
  const targetUserId = userId ?? _sessionUserId;
  if (!targetUserId) return 'unavailable';
  if (await hasLocalKeys()) return 'local_ok';
  const keychain = await restoreKeysFromKeychainSnapshot(targetUserId);
  return keychain === 'restored' ? 'restored' : keychain === 'error' ? 'error' : 'unavailable';
}

/**
 * Silent re-hydration''',
    'disable active password restore',
)

# In-memory restore may decrypt only the recovery-key backup. The already-loaded
# Master Key is sufficient; the recovery key is not needed again in that JS life.
replace_once(
    'src/lib/crypto/accountKeyBackup.ts',
    ".eq('backup_type', 'account')\n      .maybeSingle();\n",
    ".eq('backup_type', 'recovery')\n      .maybeSingle();\n",
    'in-memory recovery backup row',
)
replace_once(
    'src/lib/crypto/accountKeyBackup.ts',
    "const aad = backup.version >= 6 ? buildBackupAAD(targetUserId, 'account', backup.version) : undefined;\n",
    "const aad = backup.version >= 6 ? buildBackupAAD(targetUserId, 'recovery', backup.version) : undefined;\n",
    'in-memory recovery AAD',
)

# Recovery restore activates future background sync and never re-wraps under a
# password. The raw key is also persisted into the local archive-key store.
replace_once(
    'src/lib/crypto/accountKeyBackup.ts',
    "    // v6+ uses recoverySecret(...) (domain-separated). Legacy v5 used the raw recovery key.\n    let result = await downloadAndRestore(userId, 'recovery', recoverySecret(recoveryKey, userId)).catch(() => null);\n",
    "    const { normalizeRecoveryKey } = await import('@/lib/crypto/recoveryKey');\n    const normalizedRecoveryKey = normalizeRecoveryKey(recoveryKey);\n    // v6+ uses recoverySecret(...) (domain-separated). Legacy v5 used the raw recovery key.\n    let result = await downloadAndRestore(userId, 'recovery', recoverySecret(normalizedRecoveryKey, userId)).catch(() => null);\n",
    'normalize recovery restore key',
)
replace_once(
    'src/lib/crypto/accountKeyBackup.ts',
    "      _sessionRawMasterKey = result.masterKeyRaw;\n      _sessionMasterKey = result.masterKey;\n      dispatchSessionUnlocked(userId);\n      await writeKeychainSnapshot(userId);\n      // Re-wrap with current password if available\n      if (_sessionPassword && _sessionUserId) {\n        const secret = passwordSecret(_sessionPassword, _sessionUserId);\n        await uploadBackup(result.masterKeyRaw, result.masterKey, _sessionPassword, _sessionUserId, 'account', secret).catch((e) => {\n          logCryptoException('backup', e, { severity: 'warning', metadata: { stage: 'rewrap_after_recovery', userId } });\n        });\n      }\n",
    r'''      _sessionRawMasterKey = result.masterKeyRaw.slice();
      _sessionMasterKey = result.masterKey;
      _sessionUserId = userId;
      _sessionPassword = null;
      await persistRecoverySecretLocally(userId, normalizedRecoveryKey);
      dispatchSessionUnlocked(userId);
      await writeKeychainSnapshot(userId);
      const archive = await import('@/lib/crypto/archiveMasterKey');
      await archive.importArchiveMasterKeyFromDeviceLink(
        bufferToBase64(result.masterKeyRaw.buffer.slice(
          result.masterKeyRaw.byteOffset,
          result.masterKeyRaw.byteOffset + result.masterKeyRaw.byteLength,
        ) as ArrayBuffer),
        userId,
      );
      await purgeWeakServerBackups(userId);
''',
    'remove password rewrap after recovery',
)

replace_once(
    'src/lib/crypto/accountKeyBackup.ts',
    "  if (!_sessionRawMasterKey || !_sessionMasterKey) {\n    // Generate Master Key if we don't have one\n    const mkRaw = generateMasterKey();\n    const mk = await importMasterKey(mkRaw);\n    _sessionRawMasterKey = mkRaw;\n    _sessionMasterKey = mk;\n  }\n",
    "  if (!(await ensureStrictSessionMasterKey(userId))) return null;\n",
    'recovery backup strict session key',
)
replace_once(
    'src/lib/crypto/accountKeyBackup.ts',
    "    await uploadBackup(_sessionRawMasterKey!, _sessionMasterKey!, _sessionPassword || '', userId, 'recovery', recoverySecret(normalized, userId));\n",
    "    await persistRecoverySecretLocally(userId, normalized);\n    await uploadBackup(_sessionRawMasterKey!, _sessionMasterKey!, '', userId, 'recovery', _sessionRecoverySecret!);\n    await purgeWeakServerBackups(userId);\n",
    'recovery backup activation',
)

regex_once(
    'src/lib/crypto/accountKeyBackup.ts',
    r"export async function syncBackupToServer\(\): Promise<boolean> \{.*?\n\}\n\n/\*\* Check if auto-backup session is active \*/\nexport function isAutoBackupActive\(\): boolean \{.*?\n\}",
    r'''export async function syncBackupToServer(): Promise<boolean> {
  if (!_sessionUserId || !_sessionRecoverySecret) return false;
  if (!(await ensureStrictSessionMasterKey(_sessionUserId))) return false;
  try {
    return await uploadBackup(
      _sessionRawMasterKey!,
      _sessionMasterKey!,
      '',
      _sessionUserId,
      'recovery',
      _sessionRecoverySecret,
    );
  } catch (error) {
    logCryptoException('backup', error, {
      severity: 'error',
      metadata: { stage: 'strict_recovery_sync', userId: _sessionUserId },
    });
    return false;
  }
}

/** Check if recovery-key auto-backup is active in this client session. */
export function isAutoBackupActive(): boolean {
  return Boolean(_sessionRecoverySecret && _sessionUserId);
}''',
    'recovery-only sync public API',
)

replace_once(
    'src/lib/crypto/accountKeyBackup.ts',
    "  _sessionPassword = null;\n  _sessionUserId = null;\n",
    "  _sessionPassword = null;\n  _sessionRecoverySecret = null;\n  _sessionUserId = null;\n",
    'clear recovery session secret',
)
replace_once(
    'src/lib/crypto/accountKeyBackup.ts',
    "  if (_sessionUserId) {\n    await secureRemoveSecret(`${KEYCHAIN_SNAPSHOT_PREFIX}${_sessionUserId}`);\n  }\n",
    "  if (_sessionUserId) {\n    await Promise.all([\n      secureRemoveSecret(`${KEYCHAIN_SNAPSHOT_PREFIX}${_sessionUserId}`),\n      secureRemoveSecret(`${RECOVERY_SECRET_PREFIX}${_sessionUserId}`),\n    ]);\n  }\n",
    'unlink removes local recovery secret',
)

# PIN backup compatibility APIs become explicit local-only no-ops. The real PIN
# verifier lives in useChatPin and never wraps the Master Key.
regex_once(
    'src/lib/crypto/accountKeyBackup.ts',
    r"export async function setupBackupPin\(pin: string, userId: string\): Promise<'ok' \| 'no_master_key' \| 'invalid_pin' \| 'error'> \{.*?\n\}\n\n/\*\* Returns true if this account has a 6-digit PIN backup configured\. \*/\nexport async function hasBackupPin\(userId: string\): Promise<boolean> \{.*?\n\}\n\n/\*\* Remove the PIN backup\. \*/",
    r'''export async function setupBackupPin(
  pin: string,
  userId: string,
): Promise<'ok' | 'no_master_key' | 'invalid_pin' | 'error'> {
  if (!isValidPin(pin)) return 'invalid_pin';
  await supabase.from('backup_pin_state' as any).delete().eq('user_id', userId).catch(() => undefined);
  return 'ok';
}

/** Server-side PIN recovery is disabled; the PIN is a local application lock. */
export async function hasBackupPin(_userId: string): Promise<boolean> {
  return false;
}

/** Remove any legacy server PIN wrapper. */''',
    'disable server PIN setup and discovery',
)
regex_once(
    'src/lib/crypto/accountKeyBackup.ts',
    r"export async function restoreWithBackupPin\(pin: string, userId: string\): Promise<PinRestoreResult> \{.*?\n\}\s*$",
    r'''export async function restoreWithBackupPin(
  _pin: string,
  _userId: string,
): Promise<PinRestoreResult> {
  return { status: 'no_backup' };
}
''',
    'disable server PIN restore',
)

# Old helper module cannot recreate a server PIN blob.
write('src/lib/crypto/aegisPinBackup.ts', r'''
import { supabase } from '@/integrations/supabase/client';

export type SetupPinResult = 'ok' | 'no_master_key' | 'invalid_pin' | 'error';

/**
 * Compatibility adapter. Aegis PINs are local-only and never wrap a server
 * recovery secret. Any legacy server PIN row is removed opportunistically.
 */
export async function setupPersistentBackupPin(
  pin: string,
  userId: string,
): Promise<SetupPinResult> {
  if (!/^\d{6}$/.test(pin)) return 'invalid_pin';
  try {
    await supabase.from('backup_pin_state' as never).delete().eq('user_id', userId);
  } catch {
    // The local PIN remains valid even when legacy cleanup is unavailable.
  }
  return 'ok';
}
''')

# Local chat PIN no longer probes or restores a server-wrapped Master Key.
replace_once(
    'src/hooks/useChatPin.ts',
    " * The PIN itself never leaves the device. Supabase stores only a salt and the\n * Aegis master key wrapped by a key derived from that PIN. This lets a browser\n * recover the gate after cache loss without exposing the PIN or ratchet state.\n",
    " * The PIN itself never leaves the device and only unlocks a local verifier.\n * It is not a recovery secret and never wraps the Aegis Master Key on a server.\n",
    'local PIN documentation',
)
replace_once(
    'src/hooks/useChatPin.ts',
    "import {\n  hasBackupPin,\n  restoreWithBackupPin,\n} from '@/lib/crypto/accountKeyBackup';\nimport { setupPersistentBackupPin } from '@/lib/aegis/recovery';\n",
    "",
    'remove server PIN imports',
)
replace_once(
    'src/hooks/useChatPin.ts',
    "      const record = await loadLocalPin(user.id);\n      const serverHasPin = record ? false : await hasBackupPin(user.id);\n",
    "      const record = await loadLocalPin(user.id);\n",
    'remove server PIN lookup',
)
replace_once(
    'src/hooks/useChatPin.ts',
    "      const hasPin = Boolean(record) || serverHasPin;\n",
    "      const hasPin = Boolean(record);\n",
    'local PIN authority only',
)
regex_once(
    'src/hooks/useChatPin.ts',
    r"\n      void setupPersistentBackupPin\(pin, user\.id\).*?\n\n      // This creates only an email-reset ticket\.",
    r'''

      // This creates only an email-reset ticket.''',
    'remove initial server PIN backup',
)
regex_once(
    'src/hooks/useChatPin.ts',
    r"\n      void setupPersistentBackupPin\(pin, user\.id\).*?\n      return true;",
    r'''
      return true;''',
    'remove background server PIN backup',
)
regex_once(
    'src/hooks/useChatPin.ts',
    r"    \} else \{\n      const restored = await restoreWithBackupPin\(pin, user\.id\);.*?\n      await saveLocalPin\(user\.id, pin\);\n    \}\n",
    r'''    } else {
      setState((current) => ({
        ...current,
        processing: false,
        error: 'PIN local indisponible. Utilise la clé de récupération E2EE.',
      }));
      return false;
    }
''',
    'remove server PIN restore branch',
)

# Authentication never uses the account password to unwrap E2EE material.
replace_once(
    'src/lib/auth.tsx',
    "import {\n  clearArchiveMasterKeySession,\n  initializeArchiveMasterKeyAfterBackupCreation,\n  initializeArchiveMasterKeyFromPassword,\n} from '@/lib/crypto/archiveMasterKey';\n",
    "import {\n  clearArchiveMasterKeySession,\n  getArchiveMasterKey,\n} from '@/lib/crypto/archiveMasterKey';\n",
    'auth archive imports',
)
regex_once(
    'src/lib/auth.tsx',
    r"async function runPostSignInSetup\(password: string, userId: string\): Promise<void> \{.*?\n\}\n\nexport function AuthProvider",
    r'''async function runPostSignInSetup(_password: string, userId: string): Promise<void> {
  try {
    const r2IndexStatus = await ensureBackupIndexedFromR2(userId, 'recovery');
    console.log(`[AUTH][E2EE] recovery backup index status=${r2IndexStatus}`);
    const status = await initAccountKeySync('', userId);
    console.log(`[AUTH][E2EE] recovery-only init status=${status}`);
    const archiveKey = await getArchiveMasterKey(userId);
    console.log(`[AUTH][E2EE] local archive key=${archiveKey ? 'ready' : 'unavailable'}`);
  } catch (syncError) {
    console.warn('[AUTH][E2EE] strict recovery initialization failed:', syncError);
  }

  scheduleBackupMirrorToR2(userId, 'recovery');
  void inspectCryptoReadiness(userId, 'signed_in');

  try {
    window.dispatchEvent(new CustomEvent('forsure:authenticated-device-enroll', {
      detail: { userId, source: 'password-sign-in' },
    }));
  } catch { /* browser event delivery is best-effort */ }
}

export function AuthProvider''',
    'auth recovery-only post sign-in',
)

# Startup/resume may use native keychain or an already-loaded recovery Master Key,
# never an in-memory account password.
replace_once(
    'src/hooks/useAccountKeySync.ts',
    "  restoreAccountKeysFromActiveSession,\n",
    "",
    'remove active password restore import',
)
regex_once(
    'src/hooks/useAccountKeySync.ts',
    r"\n        const restoreStatus = await restoreAccountKeysFromActiveSession\(user\.id\);.*?\n        // Cold-start path",
    r'''
        const restoreStatus: 'unavailable' = 'unavailable';

        // Cold-start path''',
    'remove boot password restore',
)
replace_once(
    'src/hooks/useAccountKeySync.ts',
    ".eq('backup_type', 'account')\n",
    ".eq('backup_type', 'recovery')\n",
    'sentinel recovery row',
)
regex_once(
    'src/hooks/useAccountKeySync.ts',
    r"\n          if \(!recovered\) \{\n            try \{\n              recovered = \(await restoreAccountKeysFromActiveSession\(user\.id\)\) === 'restored';\n            \} catch \{.*?\n            \}\n          \}",
    "",
    'remove watchdog password restore',
)
regex_once(
    'src/hooks/useAccountKeySync.ts',
    r"\n      // 3\) In-memory password session\n      try \{.*?\n      \} catch \{.*?\n      \}",
    "",
    'remove resume password restore',
)

# R2 and backup UI default exclusively to recovery envelopes.
replace_once(
    'src/lib/crypto/r2BackupVault.ts',
    "backupType: 'account' | 'recovery' = 'account'",
    "backupType: 'account' | 'recovery' = 'recovery'",
    'R2 read default recovery',
)
# The same default appears four times.
target = Path('src/lib/crypto/r2BackupVault.ts')
source = target.read_text(encoding='utf-8')
source = source.replace("backupType: 'account' | 'recovery' = 'account'", "backupType: 'account' | 'recovery' = 'recovery'")
target.write_text(source, encoding='utf-8')

# Archive Master Key loads only from device storage or the active recovery
# session; password methods remain compatibility wrappers with no server read.
regex_once(
    'src/lib/crypto/archiveMasterKey.ts',
    r"export async function initializeArchiveMasterKeyFromPassword\(.*?\n\}\n\nexport async function initializeArchiveMasterKeyAfterBackupCreation\(.*?\n\}",
    r'''export async function initializeArchiveMasterKeyFromPassword(
  _password: string,
  userId: string,
): Promise<ArchiveMasterInitStatus> {
  return (await getArchiveMasterKey(userId)) ? 'restored' : 'no_backup';
}

export async function initializeArchiveMasterKeyAfterBackupCreation(
  _password: string,
  userId: string,
): Promise<ArchiveMasterInitStatus> {
  return (await getArchiveMasterKey(userId)) ? 'restored' : 'no_backup';
}''',
    'archive password recovery disabled',
)

# Edge vault rejects weak account reads/writes, but still accepts DELETE so the
# client can purge old mirrors on the user's next authenticated session.
replace_once(
    'supabase/functions/e2ee-backup-vault/index.ts',
    "    const backupType: BackupType = input?.backup_type === 'recovery' ? 'recovery' : 'account';\n",
    "    const requestedType = input?.backup_type;\n    const backupType: BackupType = requestedType === 'account' ? 'account' : 'recovery';\n",
    'R2 recovery default',
)
replace_once(
    'supabase/functions/e2ee-backup-vault/index.ts',
    "    const namespace = await opaqueNamespace(userId, namespaceSecret);\n",
    "    if (backupType === 'account' && action !== 'delete') {\n      return json(req, { error: 'Password-wrapped E2EE backups are disabled' }, 410);\n    }\n    const namespace = await opaqueNamespace(userId, namespaceSecret);\n",
    'R2 account block',
)

# Backup settings explain the actual security model and remove the server PIN UI.
replace_once(
    'src/components/KeyBackupPanel.tsx',
    "import { BackupPinSection } from '@/components/BackupPinSection';\n",
    "",
    'remove backup PIN component import',
)
replace_once(
    'src/components/KeyBackupPanel.tsx',
    "          Tes clés de chiffrement sont automatiquement sauvegardées avec ton compte. Si tu changes d'appareil ou vides ton cache, elles seront restaurées à la connexion.\n",
    "          Sauvegarde facultative chiffrée par une clé de récupération de 256 bits. Sans cette clé, le serveur ne peut pas restaurer tes données E2EE.\n",
    'backup panel description',
)
replace_once(
    'src/components/KeyBackupPanel.tsx',
    "                   {autoBackupOn ? 'Sauvegarde automatique active' : 'Reconnecte-toi pour activer la sauvegarde auto'}\n",
    "                   {autoBackupOn ? 'Sauvegarde recovery active pour cette session' : 'Crée ou saisis ta clé de récupération pour synchroniser'}\n",
    'backup status label',
)
replace_once(
    'src/components/KeyBackupPanel.tsx',
    "            {/* L5 — WhatsApp-style 6-digit PIN backup */}\n            <BackupPinSection />\n\n",
    "",
    'remove server backup PIN UI',
)
replace_once(
    'src/components/KeyBackupPanel.tsx',
    "                <li>Tes clés sont chiffrées avec un dérivé de ton mot de passe (jamais stocké en clair)</li>\n                <li>À chaque connexion, tes clés sont restaurées automatiquement si absentes localement</li>\n                <li>Les modifications de clés sont synchronisées en arrière-plan</li>\n                <li>Si tu changes ton mot de passe, la sauvegarde sera mise à jour à la prochaine connexion</li>\n",
    "                <li>Une clé aléatoire de 256 bits chiffre la Master Key ; elle n’est jamais envoyée au serveur</li>\n                <li>Le mot de passe du compte et le PIN local ne peuvent pas restaurer la sauvegarde</li>\n                <li>Sur mobile, la clé peut rester dans le Keychain/Keystore de cet appareil</li>\n                <li>Sans clé de récupération ni appareil lié, la restauration est volontairement impossible</li>\n",
    'backup panel strict explanation',
)

# Server-side cutover removes existing weak rows and prevents old clients from
# recreating them. R2 account mirrors are purged by the authenticated client.
write('supabase/migrations/20260729234500_recovery_key_only_e2ee_vault.sql', r'''
begin;

create or replace function public.reject_weak_e2ee_backup()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.backup_type <> 'recovery' then
    raise exception using
      errcode = '22023',
      message = 'E2EE_RECOVERY_KEY_REQUIRED';
  end if;
  return new;
end;
$$;

drop trigger if exists user_backups_recovery_key_only on public.user_backups;
create trigger user_backups_recovery_key_only
before insert or update of backup_type on public.user_backups
for each row execute function public.reject_weak_e2ee_backup();

create or replace function public.reject_server_pin_backup()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception using
    errcode = '22023',
    message = 'SERVER_PIN_BACKUP_DISABLED';
end;
$$;

drop trigger if exists backup_pin_state_local_only on public.backup_pin_state;
create trigger backup_pin_state_local_only
before insert or update on public.backup_pin_state
for each row execute function public.reject_server_pin_backup();

-- These rows are offline-verifiable with a human secret. Strict recovery mode
-- deliberately removes them; recovery-key rows remain untouched.
delete from public.backup_pin_state;
delete from public.user_backups where backup_type = 'account';

comment on function public.reject_weak_e2ee_backup() is
  'Forbids password-wrapped E2EE backups; only 256-bit recovery-key envelopes are accepted.';
comment on function public.reject_server_pin_backup() is
  'Forbids server-side six-digit PIN wrappers; chat PIN is a local application lock only.';

commit;
''')

write('src/lib/crypto/__tests__/recoveryKeyOnlyPolicy.test.ts', r'''
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
''')

# Extend audit documentation.
target = Path('docs/AEGIS_SIGNAL_AUDIT_V2.md')
source = target.read_text(encoding='utf-8')
source += r'''

## Recovery-key-only backup

Password- and six-digit-PIN-wrapped Master Keys are removed from the active
architecture. Both formats permit offline verification of a human secret after
a database or object-store compromise. The strict vault now:

- accepts only recovery backups wrapped by a random 256-bit recovery key;
- keeps that recovery key in memory or native Keychain/Keystore, never on the
  application server or R2;
- treats the six-digit messaging PIN strictly as a local UI lock;
- deletes legacy password/PIN rows and rejects recreation by older clients;
- refuses automatic E2EE restore after ordinary account authentication;
- makes recovery intentionally impossible without the recovery key or a linked
  device/native Keychain snapshot.
'''
target.write_text(source, encoding='utf-8')

print('Recovery-key-only E2EE vault generated')
