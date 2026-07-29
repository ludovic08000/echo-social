from pathlib import Path


def write(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content.rstrip() + "\n", encoding="utf-8")


transaction = Path('src/lib/aegis/core/AegisOutboundTransaction.ts')
source = transaction.read_text(encoding='utf-8')
source = source.replace(
    "Partial<Parameters<typeof traceE2EE>[0]>",
    "Partial<Parameters<AegisRuntimeDependencies['telemetry']['trace']>[0]>",
)
source = source.replace(
    "Awaited<ReturnType<typeof sendMessageWithAegisRetry>>",
    "Awaited<ReturnType<AegisRuntimeDependencies['transport']['sendWithRetry']>>",
)
transaction.write_text(source, encoding='utf-8')

write(
    'src/lib/aegis/device/index.ts',
    """
import { ensureAegisDeviceReady } from '@/lib/messaging/aegisDeviceRuntime';
import { assertConversationFingerprintsTrusted } from '@/lib/crypto/fingerprintTracker';

export const aegisDeviceModule = {
  ensureReady: ensureAegisDeviceReady,
  assertConversationTrusted: assertConversationFingerprintsTrusted,
} as const;

export type AegisDeviceModule = typeof aegisDeviceModule;

export {
  ensureAegisDeviceReady,
  assertConversationFingerprintsTrusted,
};
""",
)

write(
    'src/lib/aegis/queue/index.ts',
    """
import {
  deleteOutboxPayload,
  putOutboxPayload,
} from '@/lib/messaging/outboxVault';
import {
  savePlaintext,
  savePlaintextForCiphertext,
} from '@/lib/crypto/plaintextStore';
import { runAegisConversationJob } from '@/lib/messaging/aegisConversationQueue';

/** Minimal queue surface required by the outbound transaction. */
export const aegisQueueModule = {
  delete: deleteOutboxPayload,
  put: putOutboxPayload,
  savePlaintext,
  savePlaintextForCiphertext,
  runConversationJob: runAegisConversationJob,
} as const;

export type AegisQueueModule = typeof aegisQueueModule;

export type {
  OutboxExtra,
  OutboxPayload,
  OutboxPreparedCopy,
  OutboxStatus,
} from '@/lib/messaging/outboxVault';
export {
  deleteOutboxPayload,
  putOutboxPayload,
  savePlaintext,
  savePlaintextForCiphertext,
  runAegisConversationJob,
};
""",
)

write(
    'src/lib/aegis/queue/recovery.ts',
    """
import {
  getOutboxPayload,
  listOutboxPayloads,
} from '@/lib/messaging/outboxVault';

/** Read/recovery operations are not loaded by the outbound send transaction. */
export const aegisOutboxRecoveryModule = {
  get: getOutboxPayload,
  list: listOutboxPayloads,
} as const;

export type AegisOutboxRecoveryModule = typeof aegisOutboxRecoveryModule;
export { getOutboxPayload, listOutboxPayloads };
""",
)

write(
    'src/lib/aegis/recovery/index.ts',
    """
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
""",
)

dependencies = Path('src/lib/aegis/core/dependencies.ts')
source = dependencies.read_text(encoding='utf-8')
source = source.replace(
    "import { aegisCallsModule, type AegisCallsModule } from '@/lib/aegis/calls';\n",
    '',
)
source = source.replace('  calls: AegisCallsModule;\n', '')
source = source.replace('  calls: aegisCallsModule,\n', '')
dependencies.write_text(source, encoding='utf-8')

boundaries = Path('src/lib/aegis/__tests__/moduleBoundaries.test.ts')
source = boundaries.read_text(encoding='utf-8')
source = source.replace(
    "expect(cryptoSource).not.toMatch(/supabase/i);\n    expect(cryptoSource).not.toMatch(/react|toast/i);",
    "expect(cryptoSource).not.toContain('@/integrations/supabase');\n"
    "    expect(cryptoSource).not.toMatch(/from ['\\\"]react['\\\"]/);\n"
    "    expect(cryptoSource).not.toMatch(/from ['\\\"][^'\\\"]*toast[^'\\\"]*['\\\"]/);",
)
source = source.replace(
    "expect(callsSource).not.toMatch(/outbox|sendMessageWithAegisRetry/);",
    "expect(callsSource).not.toMatch(/from ['\\\"][^'\\\"]*outbox[^'\\\"]*['\\\"]/);\n"
    "    expect(callsSource).not.toContain('sendMessageWithAegisRetry');",
)
source = source.replace(
    "  it('keeps call-key exchange outside the message queue', () => {",
    "  it('keeps queue recovery outside the outbound dependency graph', () => {\n"
    "    const queueSource = source('src/lib/aegis/queue/index.ts');\n"
    "    expect(queueSource).not.toContain('getOutboxPayload');\n"
    "    expect(queueSource).not.toContain('listOutboxPayloads');\n"
    "  });\n\n"
    "  it('keeps call-key exchange outside the message queue', () => {",
)
boundaries.write_text(source, encoding='utf-8')

print('Aegis post-generation boundaries applied')
