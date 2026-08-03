export const AEGIS_MASTER_KEY_SCHEMA = 7 as const;

export type AegisMasterKeyBackupType = 'account' | 'recovery';

export function isCurrentMasterKeySchema(version: unknown): version is typeof AEGIS_MASTER_KEY_SCHEMA {
  return version === AEGIS_MASTER_KEY_SCHEMA;
}

export function masterKeyAADLabel(userId: string, backupType: AegisMasterKeyBackupType): string {
  return `forsure-aegis-vault|${userId}|${backupType}|schema-${AEGIS_MASTER_KEY_SCHEMA}`;
}
