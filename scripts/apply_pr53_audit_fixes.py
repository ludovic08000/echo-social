from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding='utf-8')


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected exactly one match, found {count}: {old[:120]!r}')
    write(path, content.replace(old, new, 1))


def replace_regex_once(path: str, pattern: str, replacement: str) -> None:
    content = read(path)
    updated, count = re.subn(pattern, replacement, content, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f'{path}: regex expected exactly one match, found {count}: {pattern[:120]!r}')
    write(path, updated)


write('src/lib/crypto/aegisContinuityGuards.ts', '''export interface ServerContinuityProbe {
  activeIdentity: boolean;
  accountBackup: boolean;
  backupPin: boolean;
  activeIdentityError: boolean;
  accountBackupError: boolean;
  backupPinError: boolean;
}

export type ServerContinuityDecision = 'clear' | 'continuity' | 'unavailable';

export function evaluateServerContinuityProbe(
  probe: ServerContinuityProbe,
): ServerContinuityDecision {
  if (
    probe.activeIdentityError ||
    probe.accountBackupError ||
    probe.backupPinError
  ) {
    return 'unavailable';
  }

  return probe.activeIdentity || probe.accountBackup || probe.backupPin
    ? 'continuity'
    : 'clear';
}

export function createSingleFlightByKey<T>() {
  const flights = new Map<string, Promise<T>>();

  return (key: string, factory: () => Promise<T>): Promise<T> => {
    const existing = flights.get(key);
    if (existing) return existing;

    const flight = factory().finally(() => {
      if (flights.get(key) === flight) flights.delete(key);
    });
    flights.set(key, flight);
    return flight;
  };
}
''')

replace_once(
    'src/lib/crypto/keyManager.ts',
    "import * as memCache from './memoryIdentityCache';\n",
    "import * as memCache from './memoryIdentityCache';\nimport { evaluateServerContinuityProbe } from './aegisContinuityGuards';\n",
)
replace_once(
    'src/lib/crypto/keyManager.ts',
    """    const [{ data: activeKey }, { data: backup }] = await Promise.all([\n      supabase.from('user_public_keys').select('fingerprint').eq('user_id', userId).eq('is_active', true).maybeSingle(),\n      supabase.from('user_backups').select('id').eq('user_id', userId).limit(1).maybeSingle(),\n    ]);\n\n    if (activeKey || backup) {\n      throw new PinUnlockRequiredError(\n        'PIN_UNLOCK_REQUIRED: server identity continuity detected — restore via PIN / recovery key / passkey before generating a new identity.',\n      );\n    }\n""",
    """    const [activeResult, backupResult, pinResult] = await Promise.all([\n      supabase.from('user_public_keys').select('fingerprint').eq('user_id', userId).eq('is_active', true).maybeSingle(),\n      supabase.from('user_backups').select('id').eq('user_id', userId).limit(1).maybeSingle(),\n      supabase.rpc('has_backup_pin' as never, { _user_id: userId } as never),\n    ]);\n\n    const decision = evaluateServerContinuityProbe({\n      activeIdentity: Boolean(activeResult.data),\n      accountBackup: Boolean(backupResult.data),\n      backupPin: pinResult.data === true,\n      activeIdentityError: Boolean(activeResult.error),\n      accountBackupError: Boolean(backupResult.error),\n      backupPinError: Boolean(pinResult.error),\n    });\n\n    if (decision === 'unavailable') {\n      throw new PinUnlockRequiredError(\n        'PIN_UNLOCK_REQUIRED: continuity inspection incomplete — refusing to create a replacement identity.',\n      );\n    }\n\n    if (decision === 'continuity') {\n      throw new PinUnlockRequiredError(\n        'PIN_UNLOCK_REQUIRED: server identity continuity detected — restore via PIN / recovery key / passkey before generating a new identity.',\n      );\n    }\n""",
)

replace_once(
    'src/lib/crypto/accountKeyBackup.ts',
    "import { runPostRestoreSync, type RestoreReason } from '@/lib/crypto/postRestoreSync';\n",
    "import { runPostRestoreSync, type RestoreReason } from '@/lib/crypto/postRestoreSync';\nimport { createSingleFlightByKey } from '@/lib/crypto/aegisContinuityGuards';\n",
)
replace_once(
    'src/lib/crypto/accountKeyBackup.ts',
    "let _sessionUserId: string | null = null;\n",
    "let _sessionUserId: string | null = null;\n\ntype AccountKeyInitStatus = 'restored' | 'local_ok' | 'no_backup' | 'error';\nconst runAccountKeyInitSingleFlight = createSingleFlightByKey<AccountKeyInitStatus>();\n",
)
replace_once(
    'src/lib/crypto/accountKeyBackup.ts',
    """  const { data } = await supabase\n    .from('user_backups' as any)\n    .select('encrypted_blob, iv, salt, wrapped_master_key, master_key_iv, version, backup_type')\n    .eq('user_id', userId)\n    .eq('backup_type', backupType)\n    .maybeSingle();\n\n  if (!data) return null;\n""",
    """  const { data, error } = await supabase\n    .from('user_backups' as any)\n    .select('encrypted_blob, iv, salt, wrapped_master_key, master_key_iv, version, backup_type')\n    .eq('user_id', userId)\n    .eq('backup_type', backupType)\n    .maybeSingle();\n\n  if (error) throw error;\n  if (!data) return null;\n""",
)
new_init = r'''async function hasLocalAccountIdentity(userId: string): Promise<boolean> {
  const { loadIdentityKeys } = await import('@/lib/crypto/keyManager');
  return Boolean(await loadIdentityKeys(userId));
}

async function initAccountKeySyncOnce(
  password: string,
  userId: string,
): Promise<AccountKeyInitStatus> {
  const t0 = performance.now();
  try {
    if (_sessionUserId && _sessionUserId !== userId) {
      _sessionMasterKey = null;
      _sessionRawMasterKey = null;
    }
    _sessionPassword = password;
    _sessionUserId = userId;
    const secret = passwordSecret(password, userId);
    const localIdentityBefore = await hasLocalAccountIdentity(userId);

    if (_sessionMasterKey && _sessionRawMasterKey && localIdentityBefore) {
      dispatchSessionUnlocked(userId);
      return 'local_ok';
    }

    let restored: Awaited<ReturnType<typeof downloadAndRestore>>;
    try {
      restored = await downloadAndRestore(userId, 'account', secret);
    } catch (error) {
      logCryptoException('restore', error, {
        severity: 'error',
        metadata: { stage: 'authoritative_master_key_restore', userId },
      });
      return 'error';
    }

    if (restored) {
      if (!(await hasLocalAccountIdentity(userId))) {
        logCryptoError({
          severity: 'critical', context: 'restore', errorCode: 'RESTORE_VALIDATION_FAILED',
          errorMessage: 'Master Key restored but account identity is still absent',
          metadata: { userId, durationMs: Math.round(performance.now() - t0) },
        });
        return 'error';
      }

      _sessionRawMasterKey = restored.masterKeyRaw;
      _sessionMasterKey = restored.masterKey;
      dispatchSessionUnlocked(userId);
      await writeKeychainSnapshot(userId);
      void runPostRestoreSync(userId, 'password_sign_in');
      return 'restored';
    }

    if (!localIdentityBefore) {
      return 'no_backup';
    }

    const mkRaw = generateMasterKey();
    const mk = await importMasterKey(mkRaw);
    const uploaded = await uploadBackup(mkRaw, mk, password, userId, 'account', secret);
    if (!uploaded) {
      mkRaw.fill(0);
      return 'error';
    }

    _sessionRawMasterKey = mkRaw;
    _sessionMasterKey = mk;
    dispatchSessionUnlocked(userId);
    await writeKeychainSnapshot(userId);
    return 'local_ok';
  } catch (err) {
    console.error('[MasterKey] Init failed:', err);
    logCryptoException('backup', err, {
      severity: 'critical',
      metadata: { stage: 'init', userId, durationMs: Math.round(performance.now() - t0) },
    });
    return 'error';
  }
}

/**
 * Called at login time. Restores the authoritative account Master Key or,
 * only for a verified first backup, creates exactly one key per account.
 */
export function initAccountKeySync(
  password: string,
  userId: string,
): Promise<AccountKeyInitStatus> {
  return runAccountKeyInitSingleFlight(userId, () => initAccountKeySyncOnce(password, userId));
}
'''
replace_regex_once(
    'src/lib/crypto/accountKeyBackup.ts',
    r"/\*\*\n \* Called at login time\. Derives wrapping key from password, restores or creates Master Key\.\n \*/\nexport async function initAccountKeySync\(password: string, userId: string\): Promise<'restored' \| 'local_ok' \| 'no_backup' \| 'error'> \{.*?\n\}\n(?=\n/\*\*\n \* Re-attempt restore)",
    new_init,
)
replace_once(
    'src/lib/crypto/accountKeyBackup.ts',
    """export async function createRecoveryKeyBackup(userId: string): Promise<string | null> {\n  if (!_sessionRawMasterKey || !_sessionMasterKey) {\n    // Generate Master Key if we don't have one\n    const mkRaw = generateMasterKey();\n    const mk = await importMasterKey(mkRaw);\n    _sessionRawMasterKey = mkRaw;\n    _sessionMasterKey = mk;\n  }\n""",
    """export async function createRecoveryKeyBackup(userId: string): Promise<string | null> {\n  if (!_sessionRawMasterKey || !_sessionMasterKey || _sessionUserId !== userId) {\n    console.warn('[MasterKey] Recovery backup refused: authoritative account Master Key is unavailable');\n    return null;\n  }\n""",
)
replace_once(
    'src/lib/crypto/accountKeyBackup.ts',
    """export async function syncBackupToServer(): Promise<boolean> {\n  if (!_sessionPassword || !_sessionUserId || !_sessionRawMasterKey || !_sessionMasterKey) {\n    // Fallback: generate Master Key if session has password but no MK yet\n    if (_sessionPassword && _sessionUserId) {\n      const mkRaw = generateMasterKey();\n      const mk = await importMasterKey(mkRaw);\n      _sessionRawMasterKey = mkRaw;\n      _sessionMasterKey = mk;\n    } else {\n      return false;\n    }\n  }\n""",
    """export async function syncBackupToServer(): Promise<boolean> {\n  if (!_sessionPassword || !_sessionUserId || !_sessionRawMasterKey || !_sessionMasterKey) {\n    console.warn('[MasterKey] Sync refused: authoritative account Master Key session is unavailable');\n    return false;\n  }\n""",
)

replace_once(
    'src/lib/crypto/aegisPinBackup.ts',
    "import { setupBackupPin, syncBackupToServer } from '@/lib/crypto/accountKeyBackup';\n",
    "import { setupBackupPin } from '@/lib/crypto/accountKeyBackup';\n",
)
replace_regex_once(
    'src/lib/crypto/aegisPinBackup.ts',
    r"async function setupFromAccountMasterKey\(pin: string, userId: string\): Promise<SetupPinResult> \{.*?\n\}\n(?=\n/\*\*)",
    '''async function setupFromAccountMasterKey(pin: string, userId: string): Promise<SetupPinResult> {
  let result = await setupBackupPin(pin, userId);
  if (result !== 'no_master_key') return result;

  const delays = [150, 350, 750, 1_500, 3_000];
  for (const delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    result = await setupBackupPin(pin, userId);
    if (result !== 'no_master_key') return result;
  }

  return result;
}
''',
)

replace_once(
    'src/hooks/useChatPin.ts',
    """      await saveLocalPin(user.id, pin);\n      announceUnlock(user.id);\n      pinModeRef.current = 'every_open';\n      storageSet(localStorage, `${MODE_PREFIX}${user.id}`, 'every_open');\n      setState({\n        loaded: true,\n        hasPin: true,\n        unlocked: true,\n        error: null,\n        processing: false,\n        pinMode: 'every_open',\n      });\n\n      void setupPersistentBackupPin(pin, user.id)\n        .then((result) => {\n          if (result !== 'ok') {\n            console.warn('[LOCAL-PIN] initial server backup deferred', { result });\n          }\n        })\n        .catch((error) => {\n          console.warn('[LOCAL-PIN] initial server backup failed', error);\n        });\n""",
    """      const backupResult = await setupPersistentBackupPin(pin, user.id);\n      if (backupResult !== 'ok') {\n        const error = backupResult === 'no_master_key'\n          ? 'La clé principale du compte n’est pas encore restaurée. Aucun PIN n’a été créé.'\n          : 'La sauvegarde sécurisée du PIN a échoué. Aucun PIN n’a été créé.';\n        setState((current) => ({ ...current, processing: false, unlocked: false, error }));\n        return false;\n      }\n\n      await saveLocalPin(user.id, pin);\n      announceUnlock(user.id);\n      pinModeRef.current = 'every_open';\n      storageSet(localStorage, `${MODE_PREFIX}${user.id}`, 'every_open');\n      setState({\n        loaded: true,\n        hasPin: true,\n        unlocked: true,\n        error: null,\n        processing: false,\n        pinMode: 'every_open',\n      });\n""",
)
replace_once(
    'src/hooks/useChatPin.ts',
    """      announceUnlock(user.id);\n      setState((current) => ({\n        ...current,\n        unlocked: true,\n        processing: false,\n        error: null,\n      }));\n""",
    """      const localIdentity = await loadIdentityKeys(user.id).catch(() => null);\n      if (!localIdentity) {\n        const restored = await restoreWithBackupPin(pin, user.id);\n        if (restored.status !== 'restored') {\n          const error = restored.status === 'locked'\n            ? 'Trop de tentatives. Réessayez plus tard.'\n            : restored.status === 'wrong_pin'\n              ? 'PIN incorrect'\n              : 'Identité sécurisée absente : restauration impossible avant déverrouillage.';\n          setState((current) => ({ ...current, processing: false, unlocked: false, error }));\n          return false;\n        }\n        const recoveredIdentity = await loadIdentityKeys(user.id).catch(() => null);\n        if (!recoveredIdentity) {\n          setState((current) => ({\n            ...current,\n            processing: false,\n            unlocked: false,\n            error: 'La restauration n’a pas rétabli l’identité sécurisée.',\n          }));\n          return false;\n        }\n      }\n\n      announceUnlock(user.id);\n      setState((current) => ({\n        ...current,\n        unlocked: true,\n        processing: false,\n        error: null,\n      }));\n""",
)

replace_once(
    'src/lib/crypto/signedDeviceList.ts',
    """export interface DeviceVerificationResult {\n  deviceId: string;\n  ok: boolean;\n""",
    """export interface DeviceVerificationResult {\n  deviceId: string;\n  isRoutable: boolean;\n  ok: boolean;\n""",
)
replace_once(
    'src/lib/crypto/signedDeviceList.ts',
    """      deviceId: entry.deviceId,\n      ok: false,\n      reason: 'NO_ACCOUNT_IDENTITY',\n""",
    """      deviceId: entry.deviceId,\n      isRoutable: entry.isRoutable,\n      ok: false,\n      reason: 'NO_ACCOUNT_IDENTITY',\n""",
)
replace_once(
    'src/lib/crypto/signedDeviceList.ts',
    """      deviceId: entry.deviceId,\n      ok: false,\n      reason: 'BAD_ACCOUNT_IDENTITY_BINDING',\n""",
    """      deviceId: entry.deviceId,\n      isRoutable: entry.isRoutable,\n      ok: false,\n      reason: 'BAD_ACCOUNT_IDENTITY_BINDING',\n""",
)
replace_once(
    'src/lib/crypto/signedDeviceList.ts',
    "return { deviceId: entry.deviceId, ok: false, reason: 'NO_DEVICE_AUTHORIZATION' };",
    "return { deviceId: entry.deviceId, isRoutable: entry.isRoutable, ok: false, reason: 'NO_DEVICE_AUTHORIZATION' };",
)
replace_once(
    'src/lib/crypto/signedDeviceList.ts',
    """      deviceId: entry.deviceId,\n      ok,\n      reason: ok ? 'VALID' : 'BAD_DEVICE_AUTHORIZATION',\n""",
    """      deviceId: entry.deviceId,\n      isRoutable: entry.isRoutable,\n      ok,\n      reason: ok ? 'VALID' : 'BAD_DEVICE_AUTHORIZATION',\n""",
)
replace_once(
    'src/e2ee-session/deviceRegistry.ts',
    """      const rejected = verified.verifications.filter((entry) => !entry.ok);\n      const trustedRoutable = verified.trusted.filter(\n        entry => entry.isRoutable && Boolean(entry.devicePublicKey),\n      );\n\n      if (rejected.length > 0 && typeof console !== 'undefined') {\n        console.warn('[A1] quarantining invalid device authorizations', {\n          userId: String(userId).slice(0, 8),\n          total: verified.verifications.length,\n          quarantined: rejected.map((entry) => ({\n            deviceId: String(entry.deviceId).slice(0, 8),\n            reason: entry.reason ?? 'UNKNOWN',\n          })),\n          trustedRoutable: trustedRoutable.length,\n        });\n      }\n\n      // Fail closed only when no cryptographically verified current route\n      // remains. A rejected row is excluded; it is never accepted as fallback.\n      if (trustedRoutable.length === 0) {\n        throw new Error('E2EE_DEVICE_REGISTRY_INVALID');\n      }\n""",
    """      const rejectedRoutable = verified.verifications.filter(\n        (entry) => !entry.ok && entry.isRoutable,\n      );\n      const quarantinedHistorical = verified.verifications.filter(\n        (entry) => !entry.ok && !entry.isRoutable,\n      );\n      const trustedRoutable = verified.trusted.filter(\n        entry => entry.isRoutable && Boolean(entry.devicePublicKey),\n      );\n\n      if (rejectedRoutable.length > 0) {\n        throw new Error('E2EE_DEVICE_REGISTRY_INVALID');\n      }\n\n      if (quarantinedHistorical.length > 0 && typeof console !== 'undefined') {\n        console.warn('[A1] quarantining invalid historical device authorizations', {\n          userId: String(userId).slice(0, 8),\n          total: verified.verifications.length,\n          quarantined: quarantinedHistorical.map((entry) => ({\n            deviceId: String(entry.deviceId).slice(0, 8),\n            reason: entry.reason ?? 'UNKNOWN',\n          })),\n          trustedRoutable: trustedRoutable.length,\n        });\n      }\n\n      if (trustedRoutable.length === 0) {\n        throw new Error('E2EE_DEVICE_REGISTRY_INVALID');\n      }\n""",
)

replace_once(
    'src/lib/crypto/peerKeyCache.ts',
    """  const inflight = _peerSyncPromise.get(inflightKey);\n  if (inflight) {\n    await inflight;\n    return _peerKeyCache.get(peerUserId)?.data ?? null;\n  }\n""",
    """  const inflight = _peerSyncPromise.get(inflightKey);\n  if (inflight) {\n    const previousTimestamp = cached?.ts ?? 0;\n    await inflight.catch(() => undefined);\n    const refreshed = _peerKeyCache.get(peerUserId);\n    if (options?.forceRefresh && (!refreshed || refreshed.ts <= previousTimestamp)) return null;\n    return refreshed?.data ?? null;\n  }\n""",
)
replace_once(
    'src/lib/crypto/peerKeyCache.ts',
    """    if (error) {\n      console.warn('[PEER_KEY] public key fetch failed', {\n        peerUserId,\n        error: error.message,\n      });\n      return false;\n    }\n""",
    """    if (error) {\n      console.warn('[PEER_KEY] public key fetch failed', {\n        peerUserId,\n        error: error.message,\n      });\n      if (options?.forceRefresh) _peerKeyCache.delete(peerUserId);\n      return false;\n    }\n""",
)

write('src/lib/crypto/__tests__/aegisContinuityGuards.test.ts', '''import { describe, expect, it, vi } from 'vitest';
import {
  createSingleFlightByKey,
  evaluateServerContinuityProbe,
} from '@/lib/crypto/aegisContinuityGuards';

describe('Aegis continuity guards', () => {
  it('treats any incomplete server inspection as unavailable', () => {
    expect(evaluateServerContinuityProbe({
      activeIdentity: false,
      accountBackup: false,
      backupPin: false,
      activeIdentityError: true,
      accountBackupError: false,
      backupPinError: false,
    })).toBe('unavailable');
  });

  it('detects continuity from identity, account backup, or PIN backup', () => {
    expect(evaluateServerContinuityProbe({
      activeIdentity: false,
      accountBackup: false,
      backupPin: true,
      activeIdentityError: false,
      accountBackupError: false,
      backupPinError: false,
    })).toBe('continuity');
  });

  it('coalesces concurrent initialization into one authoritative operation', async () => {
    const run = createSingleFlightByKey<string>();
    const factory = vi.fn(async () => {
      await Promise.resolve();
      return 'same-master-key';
    });

    const [first, second] = await Promise.all([
      run('account-1', factory),
      run('account-1', factory),
    ]);

    expect(first).toBe('same-master-key');
    expect(second).toBe('same-master-key');
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
''')

write('src/lib/crypto/__tests__/peerKeyCacheForceRefresh.test.ts', '''import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => {
  const chain: Record<string, any> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.order = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.maybeSingle = mocks.maybeSingle;
  return {
    supabase: {
      from: vi.fn(() => chain),
      auth: { getUser: vi.fn() },
    },
  };
});

vi.mock('@/lib/crypto/keyManager', () => ({
  verifyPublicIdentityBinding: vi.fn(async () => true),
}));

import {
  _peerKeyCache,
  _peerSyncPromise,
  fetchPeerPublicKeys,
  type PeerPublicKeys,
} from '@/lib/crypto/peerKeyCache';

const stale: PeerPublicKeys = {
  identity_key: 'old-identity',
  signing_key: 'old-signing',
  fingerprint: 'OLD',
  identity_binding_version: 1,
  identity_binding_signature: 'old-signature',
};

describe('forced peer-key refresh', () => {
  beforeEach(() => {
    _peerKeyCache.clear();
    _peerSyncPromise.clear();
    vi.clearAllMocks();
  });

  it('returns null and removes the stale cache when the network refresh fails', async () => {
    _peerKeyCache.set('peer-1', { data: stale, ts: Date.now() });
    mocks.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'offline' },
    });

    await expect(fetchPeerPublicKeys('peer-1', { forceRefresh: true })).resolves.toBeNull();
    expect(_peerKeyCache.has('peer-1')).toBe(false);
  });
});
''')

path = 'src/e2ee-session/__tests__/deviceRegistryFailClosed.test.ts'
content = read(path)
content = content.replace(
    "verifications: [{ deviceId, ok: true, reason: 'VALID' }],",
    "verifications: [{ deviceId, isRoutable: true, ok: true, reason: 'VALID' }],",
)
content = content.replace(
    "{ deviceId: 'peer-valid', ok: true, reason: 'VALID' },\n          { deviceId: 'peer-invalid', ok: false, reason: 'BAD_DEVICE_AUTHORIZATION' },",
    "{ deviceId: 'peer-valid', isRoutable: true, ok: true, reason: 'VALID' },\n          { deviceId: 'peer-invalid', isRoutable: false, ok: false, reason: 'BAD_DEVICE_AUTHORIZATION' },",
)
content = content.replace(
    "{ deviceId: 'peer-invalid', ok: false, reason: 'BAD_DEVICE_AUTHORIZATION' },",
    "{ deviceId: 'peer-invalid', isRoutable: true, ok: false, reason: 'BAD_DEVICE_AUTHORIZATION' },",
    1,
)
content = content.replace(
    "verifications: [{ deviceId: 'peer-old', ok: true, reason: 'VALID' }],",
    "verifications: [{ deviceId: 'peer-old', isRoutable: false, ok: true, reason: 'VALID' }],",
)
anchor = "  it('fails closed when a signed registry contains no valid route', async () => {\n"
extra = """  it('fails closed when an invalid authorization is still server-routable, even if another route is valid', async () => {\n    mocks.fetchVerifiedDeviceList.mockImplementation(async (userId: string) => {\n      if (userId !== 'peer') return validRegistry(userId);\n      return {\n        signedListPresent: true,\n        trusted: [{ deviceId: 'peer-valid', devicePublicKey: 'A'.repeat(44), lastSeenAt: null, isRoutable: true }],\n        verifications: [\n          { deviceId: 'peer-valid', isRoutable: true, ok: true, reason: 'VALID' },\n          { deviceId: 'peer-invalid', isRoutable: true, ok: false, reason: 'BAD_DEVICE_AUTHORIZATION' },\n        ],\n      };\n    });\n\n    await expect(\n      listFanoutTargets('sender', ['peer'], { verifyPrekeys: false }),\n    ).rejects.toThrow('E2EE_DEVICE_REGISTRY_INVALID');\n  });\n\n"""
if anchor not in content:
    raise RuntimeError('device registry test anchor missing')
content = content.replace(anchor, extra + anchor, 1)
write(path, content)

path = 'src/lib/crypto/__tests__/aegisPinRecoveryContinuity.test.ts'
content = read(path)
content = content.replace(
    "expect(pin).toContain(\"supabase.rpc('has_backup_pin'\");",
    "expect(pin).toContain(\"supabase.rpc('has_backup_pin'\");\n    expect(pin).toContain('const backupResult = await setupPersistentBackupPin');\n    expect(pin).toContain('const localIdentity = await loadIdentityKeys');\n    expect(pin).not.toContain('initial server backup deferred');",
)
content = content.replace(
    "expect(registry).toContain('quarantining invalid device authorizations');",
    "expect(registry).toContain('rejectedRoutable');\n    expect(registry).toContain('quarantining invalid historical device authorizations');",
)
content = content.replace(
    "  });\n});\n",
    """  });\n\n  it('does not generate a Master Key from sync or PIN setup fallback paths', () => {\n    const accountBackup = source('src/lib/crypto/accountKeyBackup.ts');\n    const pinBackup = source('src/lib/crypto/aegisPinBackup.ts');\n    expect(accountBackup).toContain('runAccountKeyInitSingleFlight');\n    expect(accountBackup).toContain('hasLocalAccountIdentity');\n    expect(accountBackup).toContain('Sync refused: authoritative account Master Key session is unavailable');\n    expect(pinBackup).not.toContain('syncBackupToServer');\n  });\n\n  it('does not reuse a stale peer key after a failed forced refresh', () => {\n    const peerCache = source('src/lib/crypto/peerKeyCache.ts');\n    expect(peerCache).toContain(\"if (options?.forceRefresh) _peerKeyCache.delete(peerUserId)\");\n  });\n});\n""",
    1,
)
write(path, content)

write('.github/workflows/e2ee-ci.yml', '''name: E2EE CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Legacy repository lint
        continue-on-error: true
        run: npm run lint

      - name: Typecheck
        run: npm run typecheck

      - name: Test
        shell: bash
        run: |
          set -o pipefail
          npm run test -- --reporter=verbose 2>&1 | tee vitest-output.txt

      - name: Upload Vitest diagnostics
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: vitest-diagnostics
          path: vitest-output.txt
          if-no-files-found: warn
          retention-days: 7

      - name: Build
        run: npm run build
''')

Path(__file__).unlink()
print('PR #53 audit fixes applied successfully')
