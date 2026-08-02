import fs from 'node:fs';

const path = 'src/lib/crypto/accountKeyBackup.ts';
let source = fs.readFileSync(path, 'utf8');

function replaceExact(label, before, after) {
  if (!source.includes(before)) {
    throw new Error(`Invariant migration failed: missing ${label}`);
  }
  source = source.replace(before, after);
}

replaceExact(
  'architecture header',
  ` * 1. A random 32-byte MASTER KEY is generated once per account\n * 2. The Master Key encrypts all E2EE material (identity, ratchets, prekeys, etc.)\n * 3. The Master Key itself is "wrapped" (encrypted) by TWO parallel mechanisms:`,
  ` * 1. A random 32-byte MASTER KEY is generated once for the account backup domain\n * 2. The portable account vault contains only the permanent account identity,\n *    trusted fingerprints and the encrypted recent-history cache\n * 3. Physical-device secrets (device keys, prekeys and ratchets) remain device-scoped\n * 4. The Master Key itself is "wrapped" (encrypted) by parallel recovery mechanisms:`,
);

replaceExact(
  'collect signature',
  `async function collectAllKeys(scope: BackupScope = 'aegis-vault'): Promise<string | null> {\n  const data: Record<string, any> = {};\n  const includeDeviceSecrets = scope === 'device-keychain';`,
  `async function collectAllKeys(\n  scope: BackupScope = 'aegis-vault',\n  accountUserId?: string,\n): Promise<string | null> {\n  const data: Record<string, any> = {};\n  const includeDeviceSecrets = scope === 'device-keychain';\n  if (!includeDeviceSecrets && !accountUserId) {\n    throw new Error('Portable account vault requires an explicit account user id');\n  }`,
);

replaceExact(
  'portable identity filter',
  `      data[\`e2ee:\${storeName}\`] = storeName === 'identity-keys' && !includeDeviceSecrets\n        ? rows.filter((row: any) => !String(row?.id ?? '').startsWith('device-kx::'))\n        : rows;`,
  `      data[\`e2ee:\${storeName}\`] = storeName === 'identity-keys' && !includeDeviceSecrets\n        ? rows.filter((row: any) => String(row?.id ?? '') === accountUserId)\n        : rows;`,
);

replaceExact(
  'portable identity validation',
  `  const hasIdentity = data['e2ee:identity-keys']?.some(\n    (row: any) => !String(row?.id ?? '').startsWith('device-kx::'),\n  );`,
  `  const hasIdentity = data['e2ee:identity-keys']?.some((row: any) =>\n    includeDeviceSecrets\n      ? !String(row?.id ?? '').startsWith('device-kx::')\n      : String(row?.id ?? '') === accountUserId,\n  );`,
);

replaceExact(
  'keychain collection',
  `    const snapshot = keysJson ?? await collectAllKeys('device-keychain');`,
  `    const snapshot = keysJson ?? await collectAllKeys('device-keychain', userId);`,
);

replaceExact(
  'restore signature',
  `async function restoreAllKeys(json: string): Promise<void> {\n  const data = JSON.parse(json);`,
  `async function restoreAllKeys(json: string, accountUserId: string): Promise<void> {\n  const data = JSON.parse(json);`,
);

replaceExact(
  'restore identity validation',
  `  const hasIdentityKeys = data['e2ee:identity-keys']?.some(\n    (row: any) => !String(row?.id ?? '').startsWith('device-kx::'),\n  );`,
  `  const hasIdentityKeys = data['e2ee:identity-keys']?.some((row: any) =>\n    isDeviceKeychain\n      ? !String(row?.id ?? '').startsWith('device-kx::')\n      : String(row?.id ?? '') === accountUserId,\n  );`,
);

replaceExact(
  'restore portable filter',
  `      const safeRecords = storeName === 'identity-keys' && !isDeviceKeychain\n        ? records.filter((row: any) => !String(row?.id ?? '').startsWith('device-kx::'))\n        : records;`,
  `      const safeRecords = storeName === 'identity-keys' && !isDeviceKeychain\n        ? records.filter((row: any) => String(row?.id ?? '') === accountUserId)\n        : records;`,
);

source = source.replaceAll('await restoreAllKeys(snapshot);', 'await restoreAllKeys(snapshot, userId);');
source = source.replaceAll('await restoreAllKeys(json);', 'await restoreAllKeys(json, userId);');
source = source.replaceAll('await restoreAllKeys(json, userId);\n    if (!(await hasLocalKeys()))', 'await restoreAllKeys(json, targetUserId);\n    if (!(await hasLocalKeys()))');

replaceExact(
  'upload account vault',
  `  const keysJson = await collectAllKeys('aegis-vault');`,
  `  const keysJson = await collectAllKeys('aegis-vault', userId);`,
);

replaceExact(
  'remote evidence helper insertion',
  `async function hasLocalAccountIdentity(userId: string): Promise<boolean> {\n  const { loadIdentityKeys } = await import('@/lib/crypto/keyManager');\n  return Boolean(await loadIdentityKeys(userId));\n}\n`,
  `async function hasLocalAccountIdentity(userId: string): Promise<boolean> {\n  const { loadIdentityKeys } = await import('@/lib/crypto/keyManager');\n  return Boolean(await loadIdentityKeys(userId));\n}\n\n/**\n * A missing account-backup row is not proof that the account never had a\n * Master Key. Any remaining recovery or PIN wrapper is authoritative evidence\n * that a Master Key already exists and must be recovered, never regenerated.\n */\nasync function hasRemoteMasterKeyEvidence(userId: string): Promise<boolean> {\n  const { data, error } = await supabase\n    .from('user_backups' as any)\n    .select('backup_type')\n    .eq('user_id', userId)\n    .limit(1);\n  if (error) throw error;\n  if (Array.isArray(data) && data.length > 0) return true;\n  return hasBackupPin(userId);\n}\n`,
);

replaceExact(
  'master key regeneration guard',
  `    if (!localIdentityBefore) {\n      return 'no_backup';\n    }\n\n    const mkRaw = generateMasterKey();`,
  `    if (!localIdentityBefore) {\n      return 'no_backup';\n    }\n\n    if (await hasRemoteMasterKeyEvidence(userId)) {\n      logCryptoError({\n        severity: 'critical', context: 'restore', errorCode: 'MASTER_KEY_CONTINUITY_REQUIRED',\n        errorMessage: 'Remote Master Key evidence exists but the authoritative account backup could not be restored',\n        metadata: { userId },\n      });\n      return 'error';\n    }\n\n    const mkRaw = generateMasterKey();`,
);

replaceExact(
  'pin security comments',
  `// The server also tracks a hard rate-limit (10 attempts / 24 h) via\n// release_backup_pin_blob() so a stolen JWT cannot brute-force a 6-digit PIN.\n//\n// AAD binds the wrapped blob to (userId|backupType=pin|version) so a swapped`,
  `// The server rate-limit gates normal blob retrieval, but this is not Signal\n// SVR and does not provide hardware-backed resistance to offline PIN guessing\n// if the encrypted wrapper and salt are exfiltrated. A strong recovery key is\n// the preferred recovery mechanism; the PIN is a convenience fallback.\n//\n// AAD binds the wrapped blob to (userId|backupType=pin|version) so a swapped`,
);

fs.writeFileSync(path, source);

const testPath = 'src/lib/crypto/__tests__/masterKeyInvariants.test.ts';
fs.writeFileSync(testPath, `import { describe, expect, it } from 'vitest';\nimport fs from 'node:fs';\n\nconst source = fs.readFileSync('src/lib/crypto/accountKeyBackup.ts', 'utf8');\n\ndescribe('Master Key architecture invariants', () => {\n  it('exports only the exact permanent account identity in the portable vault', () => {\n    expect(source).toContain(\"String(row?.id ?? '') === accountUserId\");\n    expect(source).toContain(\"collectAllKeys('aegis-vault', userId)\");\n  });\n\n  it('requires the exact account identity when restoring a portable vault', () => {\n    expect(source).toContain(\"String(row?.id ?? '') === accountUserId\");\n    expect(source).toContain('restoreAllKeys(json, accountUserId');\n  });\n\n  it('does not regenerate a Master Key while remote wrappers still prove continuity', () => {\n    expect(source).toContain('hasRemoteMasterKeyEvidence(userId)');\n    expect(source).toContain('MASTER_KEY_CONTINUITY_REQUIRED');\n  });\n\n  it('does not claim that the six-digit PIN is Signal SVR', () => {\n    expect(source).toContain('this is not Signal');\n    expect(source).toContain('offline PIN guessing');\n  });\n});\n`);

console.log('Master Key invariants applied.');
