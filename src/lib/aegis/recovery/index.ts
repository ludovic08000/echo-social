
import { isArchiveBackupEnabled } from '@/lib/messaging/archive/archivePrefs';

export type SetupPinResult = 'ok' | 'no_master_key' | 'invalid_pin' | 'error';

/** PIN code is loaded only when the recovery UI explicitly requests it. */
export async function setupPersistentBackupPin(
  pin: string,
  userId: string,
): Promise<SetupPinResult> {
  const module = await import('@/lib/crypto/aegisPinBackup');
  return module.setupPersistentBackupPin(pin, userId);
}

export async function prepareArchiveBody(input: {
  plaintext: string;
  conversationId: string;
  userId: string;
  messageId: string;
}): Promise<string | null> {
  const { encryptArchive } = await import('@/lib/messaging/archive/archiveKey');
  return encryptArchive(
    input.plaintext,
    input.conversationId,
    input.userId,
    input.messageId,
  );
}

export async function archiveCommittedMessage(input: {
  messageId: string;
  conversationId: string;
  userId: string;
  plaintext: string;
}): Promise<boolean> {
  const { archiveBubbleForUser } = await import('@/lib/messaging/archive/archiveKey');
  return archiveBubbleForUser(input);
}

/** Recovery capabilities used by outbound messaging; PIN has no route side effect. */
export const aegisRecoveryModule = {
  isArchiveBackupEnabled,
  prepareArchiveBody,
  archiveCommittedMessage,
} as const;

export type AegisRecoveryModule = typeof aegisRecoveryModule;
export { isArchiveBackupEnabled };
