from pathlib import Path

PATH = Path('src/lib/crypto/accountKeyBackup.ts')
text = PATH.read_text(encoding='utf-8-sig')

if "type BackupScope = 'account' | 'device';" in text:
    print('Scoped account/device backup patch already applied')
    raise SystemExit(0)


def replace_once(old: str, new: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'expected one match, got {count}: {old[:120]!r}')
    text = text.replace(old, new, 1)


replace_once(
    "const KEYCHAIN_SNAPSHOT_PREFIX = 'forsure-e2ee-keychain-snapshot-v1:';\n",
    "const KEYCHAIN_SNAPSHOT_PREFIX = 'forsure-e2ee-keychain-snapshot-v1:';\n\n"
    "type BackupScope = 'account' | 'device';\n",
)

replace_once(
    "  'forsure-spk': 'spk',\n};",
    "  'forsure-spk': 'spk',\n"
    "  'forsure-device-sessions': 'device-sessions',\n};",
)

start = text.index('/** Collect all local E2EE keys for backup */')
end = text.index('async function writeKeychainSnapshot', start)
new_collect = r'''/**
 * Collect encrypted backup material with an explicit trust boundary.
 *
 * `account` is portable across devices and therefore contains only the account
 * identity, its PIN-wrapped form and account-level fingerprint decisions.
 * Device ids, X25519 device keys, OPKs/SPKs and ratchets are deliberately
 * excluded so restoring on Windows can never impersonate the iOS device.
 *
 * `device` is a native Keychain snapshot bound to the same physical device and
 * may contain the routing id plus device-local ratchets/prekeys for WebView
 * eviction recovery.
 */
async function collectAllKeys(scope: BackupScope): Promise<string | null> {
  const data: Record<string, any> = {};

  try {
    const db = await openE2EEDB();
    for (const storeName of Array.from(db.objectStoreNames)) {
      const records = await getAllFromStore(db, storeName);
      if (scope === 'account') {
        if (storeName !== 'identity-keys') continue;
        data[`e2ee:${storeName}`] = records.filter((record: unknown) => {
          const id = (record as { id?: unknown })?.id;
          return typeof id !== 'string' || !id.startsWith('device-kx::');
        });
      } else {
        data[`e2ee:${storeName}`] = records;
      }
    }
    // db.close() skipped — shared singleton, see indexedDb.ts
  } catch {}

  try {
    data['pinwrap:keys'] = await getAllFromSideDB('forsure-pin-wrap', 'pin-wrapped-keys');
  } catch {}

  try {
    const fps = localStorage.getItem('forsure-known-fps');
    if (fps) data['fingerprints'] = fps;
  } catch {}

  if (scope === 'device') {
    try {
      data['ratchet:states'] = await getAllFromSideDB('forsure-ratchet', 'ratchet-states');
    } catch {}

    try {
      data['prekeys:private'] = await getAllFromSideDB('forsure-prekeys', 'private-prekeys');
    } catch {}

    try {
      data['spk:private'] = await getAllFromSideDB('forsure-spk', 'signed-prekeys');
    } catch {}

    try {
      data['device:sessions'] = await getAllFromSideDB('forsure-device-sessions', 'sessions');
    } catch {}

    try {
      const db = await openE2EEDB();
      data['device:kx'] = (await getAllFromStore(db, 'identity-keys'))
        .filter((record: unknown) => {
          const id = (record as { id?: unknown })?.id;
          return typeof id === 'string' && id.startsWith('device-kx::');
        });
      data['device:id'] = getCurrentDeviceId();
    } catch {}

    try {
      const plaintextCache = await exportPlaintextCache();
      if (plaintextCache.length > 0) data['plaintext:cache'] = plaintextCache;
    } catch {}
  }

  const hasIdentity = data['e2ee:identity-keys']?.length > 0 || data['pinwrap:keys']?.length > 0;
  if (!hasIdentity) return null;

  data['_meta'] = {
    version: BACKUP_VERSION,
    scope,
    createdAt: new Date().toISOString(),
    stores: Object.keys(data).filter(k => k !== '_meta'),
  };

  return JSON.stringify(data);
}

'''
text = text[:start] + new_collect + text[end:]

replace_once(
    "    const snapshot = keysJson ?? await collectAllKeys();",
    "    const snapshot = keysJson ?? await collectAllKeys('device');",
)
replace_once(
    "    await restoreAllKeys(snapshot);",
    "    await restoreAllKeys(snapshot, 'device');",
)
replace_once(
    "async function restoreAllKeys(json: string): Promise<void> {",
    "async function restoreAllKeys(json: string, scope: BackupScope): Promise<void> {",
)
replace_once(
    "    if (typeof data['device:id'] === 'string' && data['device:id'].length >= 16) {",
    "    if (scope === 'device' && typeof data['device:id'] === 'string' && data['device:id'].length >= 16) {",
)

old_loop = '''      const storeName = key.replace('e2ee:', '');
      const db = await openE2EEDB();
      if (db.objectStoreNames.contains(storeName)) {
        const existing = await getAllFromStore(db, storeName);
        await putAllInStore(db, storeName, records);
'''
new_loop = '''      const storeName = key.replace('e2ee:', '');
      if (scope === 'account' && storeName !== 'identity-keys') continue;
      const db = await openE2EEDB();
      if (db.objectStoreNames.contains(storeName)) {
        const existing = await getAllFromStore(db, storeName);
        const scopedRecords = scope === 'account' && storeName === 'identity-keys'
          ? [
              ...existing.filter((record: unknown) => {
                const id = (record as { id?: unknown })?.id;
                return typeof id === 'string' && id.startsWith('device-kx::');
              }),
              ...records.filter((record: unknown) => {
                const id = (record as { id?: unknown })?.id;
                return typeof id !== 'string' || !id.startsWith('device-kx::');
              }),
            ]
          : records;
        await putAllInStore(db, storeName, scopedRecords);
'''
replace_once(old_loop, new_loop)

replace_once(
    "    if (Array.isArray(data['device:kx'])) {",
    "    if (scope === 'device' && Array.isArray(data['device:kx'])) {",
)
replace_once(
    "    if (Array.isArray(data['ratchet:states'])) {",
    "    if (scope === 'device' && Array.isArray(data['ratchet:states'])) {",
)
replace_once(
    "    if (Array.isArray(data['prekeys:private'])) {",
    "    if (scope === 'device' && Array.isArray(data['prekeys:private'])) {",
)
replace_once(
    "    if (Array.isArray(data['spk:private'])) {",
    "    if (scope === 'device' && Array.isArray(data['spk:private'])) {",
)
replace_once(
    "    if (Array.isArray(data['plaintext:cache'])) {",
    "    if (scope === 'device' && Array.isArray(data['plaintext:cache'])) {",
)

fingerprint_marker = '''    // Phase 5: Fingerprints
'''
device_sessions_restore = '''    // Phase 4c: per-device Double Ratchet sessions. These are only restored
    // from the native snapshot of the same physical device.
    if (scope === 'device' && Array.isArray(data['device:sessions'])) {
      const existing = await getAllFromSideDB('forsure-device-sessions', 'sessions');
      await putAllInSideDB('forsure-device-sessions', 'sessions', data['device:sessions']);
      rollbackOps.push(async () => {
        await putAllInSideDB('forsure-device-sessions', 'sessions', existing);
      });
    }

'''
replace_once(fingerprint_marker, device_sessions_restore + fingerprint_marker)

replace_once(
    "  const keysJson = await collectAllKeys();",
    "  const keysJson = await collectAllKeys('account');",
)
replace_once(
    "      await writeKeychainSnapshot(userId, keysJson);",
    "      await writeKeychainSnapshot(userId);",
)

account_restore_count = text.count('await restoreAllKeys(json);')
if account_restore_count < 3:
    raise RuntimeError(f'expected at least three server restore calls, got {account_restore_count}')
text = text.replace("await restoreAllKeys(json);", "await restoreAllKeys(json, 'account');")

PATH.write_text(text, encoding='utf-8')
print(f'Applied scoped backup boundary; updated {account_restore_count} account restore calls')
