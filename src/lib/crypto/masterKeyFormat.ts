export type AegisMasterKeyBackupType = 'account' | 'recovery';

/**
 * Invariant Aegis : il n'existe qu'un seul format de coffre Master Key.
 * L'AAD lie définitivement le coffre au compte et à son usage, sans version.
 */
export function masterKeyAADLabel(userId: string, backupType: AegisMasterKeyBackupType): string {
  return `forsure-aegis-vault|${userId}|${backupType}`;
}
