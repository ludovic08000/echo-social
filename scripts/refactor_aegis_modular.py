from __future__ import annotations

from pathlib import Path
import re

ROOT = Path.cwd()
BRANCH = "refactor/aegis-modular-architecture"


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content.rstrip() + "\n", encoding="utf-8")


def replace_exact(source: str, old: str, new: str, *, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one occurrence, found {count}")
    return source.replace(old, new, 1)


# ---------------------------------------------------------------------------
# Public contracts and state
# ---------------------------------------------------------------------------
write(
    "src/lib/aegis/core/types.ts",
    """
import type {
  OutboxExtra,
  OutboxPayload,
} from '@/lib/messaging/outboxVault';
import type { FanoutCopyRow } from '@/lib/messaging/multiDeviceFanout';

export type { FanoutCopyRow, OutboxExtra, OutboxPayload };

export interface AegisOutboundInput {
  conversationId: string;
  senderUserId: string;
  plaintext: string;
  imageUrl?: string | null;
  extra?: OutboxExtra;
  localId?: string;
  traceId?: string;
  messageId?: string;
  createdAt?: number;
  resumePayload?: OutboxPayload | null;
  onState?: (payload: OutboxPayload) => void | Promise<void>;
}

export interface AegisOutboundResult {
  id: string;
  parentBody: string;
  transportPlaintext: string;
  copies: FanoutCopyRow[];
  retriedStaleRoute: boolean;
  localId: string;
  traceId: string;
}
""",
)

write(
    "src/lib/aegis/core/stateMachine.ts",
    """
import type { OutboxStatus } from '@/lib/messaging/outboxVault';

export const AEGIS_OUTBOX_TRANSITIONS = {
  draft: ['pending_local', 'failed_visible'],
  pending_local: ['encrypting', 'sending', 'failed_visible'],
  encrypting: ['waiting_secure_channel', 'sending', 'retry_pending', 'failed_visible'],
  waiting_secure_channel: ['encrypting', 'retry_pending', 'failed_visible'],
  sending: ['sent', 'retry_pending', 'waiting_secure_channel', 'failed_visible'],
  sent: [],
  retry_pending: ['encrypting', 'sending', 'waiting_secure_channel', 'failed_visible'],
  failed_visible: ['pending_local', 'encrypting', 'sending'],
} as const satisfies Record<OutboxStatus, readonly OutboxStatus[]>;

export function canTransitionAegisOutbox(
  from: OutboxStatus,
  to: OutboxStatus,
): boolean {
  if (from === to) return true;
  return (AEGIS_OUTBOX_TRANSITIONS[from] as readonly OutboxStatus[]).includes(to);
}

export function assertAegisOutboxTransition(
  from: OutboxStatus,
  to: OutboxStatus,
): void {
  if (!canTransitionAegisOutbox(from, to)) {
    throw new Error(`AEGIS_INVALID_OUTBOX_TRANSITION:${from}->${to}`);
  }
}
""",
)

write(
    "src/lib/aegis/core/errors.ts",
    """
import type { OutboxStatus } from '@/lib/messaging/outboxVault';

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? 'Echec du transport chiffre.');
  }
  return String(error ?? 'Echec du transport chiffre.');
}

export function failureStatus(error: unknown): OutboxStatus {
  const text = errorMessage(error).toLowerCase();
  if (
    text.includes('401') ||
    text.includes('jwt') ||
    text.includes('not_authenticated') ||
    text.includes('pin unlock required') ||
    text.includes('verification obligatoire') ||
    text.includes('fingerprint changed') ||
    text.includes('fingerprint_changed')
  ) {
    return 'failed_visible';
  }
  if (
    text.includes('e2ee_device') ||
    text.includes('e2ee_sender_device_not_trusted') ||
    text.includes('e2ee_sender_device_required') ||
    text.includes('e2ee_participant_route_unavailable') ||
    text.includes('e2ee_no_secure_target') ||
    text.includes('device_prekey_bundle_unavailable') ||
    text.includes('signed_device_list_missing') ||
    text.includes('device_spk_signature_invalid')
  ) {
    return 'waiting_secure_channel';
  }
  return 'retry_pending';
}

export function requestSenderTrustRepair(error: unknown): void {
  const text = errorMessage(error).toLowerCase();
  if (
    !text.includes('e2ee_sender_device_not_trusted') &&
    !text.includes('e2ee_sender_device_required')
  ) {
    return;
  }

  try {
    window.dispatchEvent(new CustomEvent('forsure:device-self-repair-required', {
      detail: { reason: 'sender-route-not-trusted' },
    }));
  } catch {
    // Browser event delivery is best-effort outside the DOM runtime.
  }
}
""",
)

# ---------------------------------------------------------------------------
# Independent modules. Each object is injectable and exposes a small API.
# ---------------------------------------------------------------------------
write(
    "src/lib/aegis/core/ids.ts",
    """
import { safeUUID } from '@/e2ee-session';

export const aegisIdModule = {
  uuid: safeUUID,
} as const;

export type AegisIdModule = typeof aegisIdModule;
""",
)

write(
    "src/lib/aegis/core/telemetry.ts",
    """
import { traceE2EE } from '@/lib/messaging/e2eeTrace';

export const aegisTelemetryModule = {
  trace: traceE2EE,
} as const;

export type AegisTelemetryModule = typeof aegisTelemetryModule;
""",
)

write(
    "src/lib/aegis/device/index.ts",
    """
import {
  ensureAegisDeviceReady,
  invalidateAegisDeviceRuntime,
} from '@/lib/messaging/aegisDeviceRuntime';
import { assertConversationFingerprintsTrusted } from '@/lib/crypto/fingerprintTracker';

export const aegisDeviceModule = {
  ensureReady: ensureAegisDeviceReady,
  invalidate: invalidateAegisDeviceRuntime,
  assertConversationTrusted: assertConversationFingerprintsTrusted,
} as const;

export type AegisDeviceModule = typeof aegisDeviceModule;

export {
  ensureAegisDeviceReady,
  invalidateAegisDeviceRuntime,
  assertConversationFingerprintsTrusted,
};
""",
)

write(
    "src/lib/aegis/crypto/index.ts",
    """
import { createAegisMessage } from '@/lib/messaging/aegisEnvelope';

/** Pure message-envelope crypto. No Supabase, React or UI dependency here. */
export const aegisCryptoModule = {
  createMessage: createAegisMessage,
} as const;

export type AegisCryptoModule = typeof aegisCryptoModule;

export { createAegisMessage };
""",
)

write(
    "src/lib/aegis/routing/index.ts",
    """
import {
  buildFanoutCopies,
  type FanoutCopyRow,
} from '@/lib/messaging/multiDeviceFanout';
import { rollbackFanoutSessionTransaction } from '@/lib/messaging/fanoutSessionTransaction';

export const aegisRoutingModule = {
  buildCopies: buildFanoutCopies,
  rollback: rollbackFanoutSessionTransaction,
} as const;

export type AegisRoutingModule = typeof aegisRoutingModule;
export type { FanoutCopyRow };
export { buildFanoutCopies, rollbackFanoutSessionTransaction };
""",
)

write(
    "src/lib/aegis/transport/index.ts",
    """
import {
  isAegisAmbiguousTransportFailure,
  sendMessageWithAegisRetry,
} from '@/lib/messaging/aegisSendRpc';
import {
  MAX_INLINE_MESSAGE_BODY_BYTES,
  prepareLongMessageForSend,
  utf8ByteLength,
} from '@/lib/messaging/longMessageAttachment';

export const aegisTransportModule = {
  sendWithRetry: sendMessageWithAegisRetry,
  isAmbiguousFailure: isAegisAmbiguousTransportFailure,
  maxInlineBodyBytes: MAX_INLINE_MESSAGE_BODY_BYTES,
  prepareLongMessage: prepareLongMessageForSend,
  utf8ByteLength,
} as const;

export type AegisTransportModule = typeof aegisTransportModule;

export {
  isAegisAmbiguousTransportFailure,
  sendMessageWithAegisRetry,
  MAX_INLINE_MESSAGE_BODY_BYTES,
  prepareLongMessageForSend,
  utf8ByteLength,
};
""",
)

write(
    "src/lib/aegis/queue/index.ts",
    """
import {
  deleteOutboxPayload,
  getOutboxPayload,
  listOutboxPayloads,
  putOutboxPayload,
} from '@/lib/messaging/outboxVault';
import {
  savePlaintext,
  savePlaintextForCiphertext,
} from '@/lib/crypto/plaintextStore';
import { runAegisConversationJob } from '@/lib/messaging/aegisConversationQueue';

export const aegisQueueModule = {
  delete: deleteOutboxPayload,
  get: getOutboxPayload,
  list: listOutboxPayloads,
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
  getOutboxPayload,
  listOutboxPayloads,
  putOutboxPayload,
  savePlaintext,
  savePlaintextForCiphertext,
  runAegisConversationJob,
};
""",
)

write(
    "src/lib/aegis/recovery/index.ts",
    """
import { setupPersistentBackupPin } from '@/lib/crypto/aegisPinBackup';
import { isArchiveBackupEnabled } from '@/lib/messaging/archive/archivePrefs';

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

export const aegisRecoveryModule = {
  setupPersistentBackupPin,
  isArchiveBackupEnabled,
  prepareArchiveBody,
  archiveCommittedMessage,
} as const;

export type AegisRecoveryModule = typeof aegisRecoveryModule;

export { setupPersistentBackupPin, isArchiveBackupEnabled };
""",
)

write(
    "src/lib/aegis/calls/index.ts",
    """
import {
  decryptCallKey,
  encryptCallKey,
} from '@/lib/crypto/callKeyEncrypt';

/** LiveKit call-key exchange is independent from the message outbox. */
export const aegisCallsModule = {
  encryptCallKey,
  decryptCallKey,
} as const;

export type AegisCallsModule = typeof aegisCallsModule;
export { encryptCallKey, decryptCallKey };
""",
)

write(
    "src/lib/aegis/compatibility/index.ts",
    """
import {
  isAegisDeviceCopyWire,
  isMultiDeviceEnvelopeBody,
} from '@/lib/messaging/messageCompatibility';

export const aegisCompatibilityModule = {
  isDeviceCopyWire: isAegisDeviceCopyWire,
  isMultiDeviceEnvelopeBody,
} as const;

export type AegisCompatibilityModule = typeof aegisCompatibilityModule;
export { isAegisDeviceCopyWire, isMultiDeviceEnvelopeBody };
""",
)

write(
    "src/lib/aegis/core/dependencies.ts",
    """
import { aegisCallsModule, type AegisCallsModule } from '@/lib/aegis/calls';
import {
  aegisCompatibilityModule,
  type AegisCompatibilityModule,
} from '@/lib/aegis/compatibility';
import { aegisCryptoModule, type AegisCryptoModule } from '@/lib/aegis/crypto';
import { aegisDeviceModule, type AegisDeviceModule } from '@/lib/aegis/device';
import { aegisQueueModule, type AegisQueueModule } from '@/lib/aegis/queue';
import { aegisRecoveryModule, type AegisRecoveryModule } from '@/lib/aegis/recovery';
import { aegisRoutingModule, type AegisRoutingModule } from '@/lib/aegis/routing';
import { aegisTransportModule, type AegisTransportModule } from '@/lib/aegis/transport';
import { aegisIdModule, type AegisIdModule } from './ids';
import { aegisTelemetryModule, type AegisTelemetryModule } from './telemetry';

export interface AegisRuntimeDependencies {
  ids: AegisIdModule;
  device: AegisDeviceModule;
  crypto: AegisCryptoModule;
  routing: AegisRoutingModule;
  transport: AegisTransportModule;
  queue: AegisQueueModule;
  recovery: AegisRecoveryModule;
  calls: AegisCallsModule;
  compatibility: AegisCompatibilityModule;
  telemetry: AegisTelemetryModule;
}

export const defaultAegisDependencies: AegisRuntimeDependencies = Object.freeze({
  ids: aegisIdModule,
  device: aegisDeviceModule,
  crypto: aegisCryptoModule,
  routing: aegisRoutingModule,
  transport: aegisTransportModule,
  queue: aegisQueueModule,
  recovery: aegisRecoveryModule,
  calls: aegisCallsModule,
  compatibility: aegisCompatibilityModule,
  telemetry: aegisTelemetryModule,
});
""",
)

# ---------------------------------------------------------------------------
# Move the existing transaction behind injected modules.
# ---------------------------------------------------------------------------
legacy_path = ROOT / "src/lib/messaging/aegisOutboundEngine.ts"
legacy = legacy_path.read_text(encoding="utf-8")

import_start = legacy.index("import { safeUUID")
import_marker = "import { traceE2EE } from '@/lib/messaging/e2eeTrace';\n"
import_end = legacy.index(import_marker) + len(import_marker)
new_imports = """import type {
  AegisOutboundInput,
  AegisOutboundResult,
  FanoutCopyRow,
  OutboxPayload,
} from './types';
import {
  defaultAegisDependencies,
  type AegisRuntimeDependencies,
} from './dependencies';
import {
  errorMessage,
  failureStatus,
  requestSenderTrustRepair,
} from './errors';

"""
legacy = legacy[:import_start] + new_imports + legacy[import_end:]

interfaces_start = legacy.index("export interface AegisOutboundInput")
errors_start = legacy.index("function errorMessage")
legacy = legacy[:interfaces_start] + legacy[errors_start:]

errors_start = legacy.index("function errorMessage")
engine_comment = "/**\n * The only encrypted outbound engine."
errors_end = legacy.index(engine_comment)
legacy = legacy[:errors_start] + legacy[errors_end:]

legacy = replace_exact(
    legacy,
    "export async function sendAegisOutboundMessage(\n  input: AegisOutboundInput,\n): Promise<AegisOutboundResult> {",
    "export async function executeAegisOutboundTransaction(\n  input: AegisOutboundInput,\n  deps: AegisRuntimeDependencies = defaultAegisDependencies,\n): Promise<AegisOutboundResult> {",
    label="rename outbound transaction",
)

replacements = {
    "safeUUID()": "deps.ids.uuid()",
    "ensureAegisDeviceReady(": "deps.device.ensureReady(",
    "assertConversationFingerprintsTrusted(": "deps.device.assertConversationTrusted(",
    "createAegisMessage(": "deps.crypto.createMessage(",
    "savePlaintextForCiphertext(": "deps.queue.savePlaintextForCiphertext(",
    "savePlaintext(": "deps.queue.savePlaintext(",
    "putOutboxPayload(": "deps.queue.put(",
    "deleteOutboxPayload(": "deps.queue.delete(",
    "runAegisConversationJob(": "deps.queue.runConversationJob(",
    "buildFanoutCopies(": "deps.routing.buildCopies(",
    "rollbackFanoutSessionTransaction(": "deps.routing.rollback(",
    "sendMessageWithAegisRetry(": "deps.transport.sendWithRetry(",
    "isAegisAmbiguousTransportFailure(": "deps.transport.isAmbiguousFailure(",
    "isAegisDeviceCopyWire(": "deps.compatibility.isDeviceCopyWire(",
    "isMultiDeviceEnvelopeBody(": "deps.compatibility.isMultiDeviceEnvelopeBody(",
    "isArchiveBackupEnabled()": "deps.recovery.isArchiveBackupEnabled()",
    "utf8ByteLength(": "deps.transport.utf8ByteLength(",
    "MAX_INLINE_MESSAGE_BODY_BYTES": "deps.transport.maxInlineBodyBytes",
    "prepareLongMessageForSend(": "deps.transport.prepareLongMessage(",
    "traceE2EE(": "deps.telemetry.trace(",
}
for old, new in replacements.items():
    legacy = legacy.replace(old, new)

archive_prepare_pattern = re.compile(
    r"  if \(archiveBackupEnabled && !archiveBody\) \{\n"
    r"    const \{ encryptArchive \} = await import\('@/lib/messaging/archive/archiveKey'\);\n"
    r"    archiveBody = await encryptArchive\(\n"
    r"      input\.plaintext,\n"
    r"      input\.conversationId,\n"
    r"      input\.senderUserId,\n"
    r"      messageId,\n"
    r"    \);\n"
    r"    if \(!archiveBody\) throw new Error\('AEGIS_ARCHIVE_PREPARE_FAILED'\);\n"
    r"    await persist\(\{ archiveBody \}\);\n"
    r"  \}",
)
legacy, count = archive_prepare_pattern.subn(
    """  if (archiveBackupEnabled && !archiveBody) {
    archiveBody = await deps.recovery.prepareArchiveBody({
      plaintext: input.plaintext,
      conversationId: input.conversationId,
      userId: input.senderUserId,
      messageId,
    });
    if (!archiveBody) throw new Error('AEGIS_ARCHIVE_PREPARE_FAILED');
    await persist({ archiveBody });
  }""",
    legacy,
    count=1,
)
if count != 1:
    raise SystemExit(f"archive preparation extraction failed: {count}")

archive_commit_pattern = re.compile(
    r"  if \(archiveBackupEnabled\) \{\n"
    r"    void import\('@/lib/messaging/archive/archiveKey'\)\.then\(\(\{ archiveBubbleForUser \}\) =>\n"
    r"      archiveBubbleForUser\(\{\n"
    r"        messageId: committedId,\n"
    r"        conversationId: input\.conversationId,\n"
    r"        userId: input\.senderUserId,\n"
    r"        plaintext: input\.plaintext,\n"
    r"      \}\),\n"
    r"    \)\.catch\(\(\) => false\);\n"
    r"  \}",
)
legacy, count = archive_commit_pattern.subn(
    """  if (archiveBackupEnabled) {
    void deps.recovery.archiveCommittedMessage({
      messageId: committedId,
      conversationId: input.conversationId,
      userId: input.senderUserId,
      plaintext: input.plaintext,
    }).catch(() => false);
  }""",
    legacy,
    count=1,
)
if count != 1:
    raise SystemExit(f"archive committed extraction failed: {count}")

for forbidden in (
    "@/lib/messaging/aegisDeviceRuntime",
    "@/lib/messaging/aegisSendRpc",
    "@/lib/messaging/multiDeviceFanout",
    "@/lib/messaging/outboxVault",
    "@/integrations/supabase/client",
):
    if forbidden in legacy:
        raise SystemExit(f"transaction still imports forbidden dependency: {forbidden}")

write("src/lib/aegis/core/AegisOutboundTransaction.ts", legacy)

write(
    "src/lib/aegis/core/AegisOrchestrator.ts",
    """
import {
  defaultAegisDependencies,
  type AegisRuntimeDependencies,
} from './dependencies';
import { executeAegisOutboundTransaction } from './AegisOutboundTransaction';
import type { AegisOutboundInput, AegisOutboundResult } from './types';

export type AegisOutboundTransaction = (
  input: AegisOutboundInput,
  dependencies: AegisRuntimeDependencies,
) => Promise<AegisOutboundResult>;

export class AegisOrchestrator {
  constructor(
    private readonly dependencies: AegisRuntimeDependencies = defaultAegisDependencies,
    private readonly transaction: AegisOutboundTransaction = executeAegisOutboundTransaction,
  ) {}

  send(input: AegisOutboundInput): Promise<AegisOutboundResult> {
    return this.transaction(input, this.dependencies);
  }
}

export function createAegisOrchestrator(
  dependencies: AegisRuntimeDependencies = defaultAegisDependencies,
  transaction: AegisOutboundTransaction = executeAegisOutboundTransaction,
): AegisOrchestrator {
  return new AegisOrchestrator(dependencies, transaction);
}

export const defaultAegisOrchestrator = createAegisOrchestrator();

export function sendAegisOutboundMessage(
  input: AegisOutboundInput,
): Promise<AegisOutboundResult> {
  return defaultAegisOrchestrator.send(input);
}
""",
)

write(
    "src/lib/aegis/index.ts",
    """
export {
  AegisOrchestrator,
  createAegisOrchestrator,
  defaultAegisOrchestrator,
  sendAegisOutboundMessage,
  type AegisOutboundTransaction,
} from './core/AegisOrchestrator';
export type {
  AegisOutboundInput,
  AegisOutboundResult,
  FanoutCopyRow,
  OutboxExtra,
  OutboxPayload,
} from './core/types';
export {
  AEGIS_OUTBOX_TRANSITIONS,
  assertAegisOutboxTransition,
  canTransitionAegisOutbox,
} from './core/stateMachine';
export {
  errorMessage,
  failureStatus,
  requestSenderTrustRepair,
} from './core/errors';
""",
)

# Historical path remains a tiny adapter for old tests and imports.
write(
    "src/lib/messaging/aegisOutboundEngine.ts",
    """
export {
  AegisOrchestrator,
  createAegisOrchestrator,
  defaultAegisOrchestrator,
  sendAegisOutboundMessage,
  type AegisOutboundTransaction,
} from '@/lib/aegis/core/AegisOrchestrator';
export type {
  AegisOutboundInput,
  AegisOutboundResult,
} from '@/lib/aegis/core/types';
""",
)

# Active consumers use the modular public API. Legacy import path remains valid.
for path in (ROOT / "src").rglob("*.ts*"):
    if "src/lib/aegis/" in path.as_posix():
        continue
    source = path.read_text(encoding="utf-8")
    updated = source.replace(
        "@/lib/messaging/aegisOutboundEngine",
        "@/lib/aegis",
    )
    updated = updated.replace(
        "@/lib/crypto/callKeyEncrypt",
        "@/lib/aegis/calls",
    )
    updated = updated.replace(
        "@/lib/crypto/aegisPinBackup",
        "@/lib/aegis/recovery",
    )
    if updated != source:
        path.write_text(updated, encoding="utf-8")

# Tests that specifically verify the historical adapter must keep the old path.
engine_test = ROOT / "src/lib/messaging/__tests__/aegisOutboundEngine.test.ts"
engine_test_source = engine_test.read_text(encoding="utf-8").replace(
    "import { sendAegisOutboundMessage } from '@/lib/aegis';",
    "import { sendAegisOutboundMessage } from '@/lib/messaging/aegisOutboundEngine';",
)
engine_test.write_text(engine_test_source, encoding="utf-8")

# ---------------------------------------------------------------------------
# Focused module tests
# ---------------------------------------------------------------------------
write(
    "src/lib/aegis/__tests__/AegisOrchestrator.test.ts",
    """
import { describe, expect, it, vi } from 'vitest';
import {
  AegisOrchestrator,
  type AegisOutboundTransaction,
} from '../core/AegisOrchestrator';
import type { AegisRuntimeDependencies } from '../core/dependencies';
import type { AegisOutboundInput, AegisOutboundResult } from '../core/types';

const input: AegisOutboundInput = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  senderUserId: '22222222-2222-4222-8222-222222222222',
  plaintext: 'hello',
};

const result: AegisOutboundResult = {
  id: '33333333-3333-4333-8333-333333333333',
  parentBody: 'encrypted-parent',
  transportPlaintext: 'hello',
  copies: [],
  retriedStaleRoute: false,
  localId: 'local-1',
  traceId: 'trace-1',
};

describe('AegisOrchestrator', () => {
  it('delegates one send to the injected transaction with the injected modules', async () => {
    const dependencies = { marker: 'deps' } as unknown as AegisRuntimeDependencies;
    const transaction = vi.fn<AegisOutboundTransaction>().mockResolvedValue(result);
    const orchestrator = new AegisOrchestrator(dependencies, transaction);

    await expect(orchestrator.send(input)).resolves.toEqual(result);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(input, dependencies);
  });
});
""",
)

write(
    "src/lib/aegis/__tests__/errors.test.ts",
    """
import { describe, expect, it } from 'vitest';
import { failureStatus } from '../core/errors';

 describe('Aegis error classification', () => {
  it('keeps route failures waiting for the secure channel', () => {
    expect(failureStatus(new Error('E2EE_DEVICE_COPIES_UNAVAILABLE')))
      .toBe('waiting_secure_channel');
  });

  it('makes authentication and PIN failures visible', () => {
    expect(failureStatus(new Error('401 JWT unauthorized'))).toBe('failed_visible');
    expect(failureStatus(new Error('PIN unlock required'))).toBe('failed_visible');
  });

  it('retries ambiguous transport failures', () => {
    expect(failureStatus(new Error('NETWORK_TRANSPORT_TIMEOUT'))).toBe('retry_pending');
  });
});
""",
)

write(
    "src/lib/aegis/__tests__/stateMachine.test.ts",
    """
import { describe, expect, it } from 'vitest';
import {
  assertAegisOutboxTransition,
  canTransitionAegisOutbox,
} from '../core/stateMachine';

 describe('Aegis outbox state machine', () => {
  it('allows the normal encrypted send lifecycle', () => {
    expect(canTransitionAegisOutbox('pending_local', 'encrypting')).toBe(true);
    expect(canTransitionAegisOutbox('encrypting', 'sending')).toBe(true);
    expect(canTransitionAegisOutbox('sending', 'sent')).toBe(true);
  });

  it('rejects a committed message returning to encryption', () => {
    expect(() => assertAegisOutboxTransition('sent', 'encrypting'))
      .toThrow('AEGIS_INVALID_OUTBOX_TRANSITION');
  });
});
""",
)

write(
    "src/lib/aegis/__tests__/moduleBoundaries.test.ts",
    """
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sendAegisOutboundMessage as modularSend } from '@/lib/aegis';
import { sendAegisOutboundMessage as legacySend } from '@/lib/messaging/aegisOutboundEngine';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('Aegis module boundaries', () => {
  it('keeps the historical outbound import as the same public function', () => {
    expect(legacySend).toBe(modularSend);
  });

  it('keeps the crypto facade free of network and UI dependencies', () => {
    const cryptoSource = source('src/lib/aegis/crypto/index.ts');
    expect(cryptoSource).not.toMatch(/supabase/i);
    expect(cryptoSource).not.toMatch(/react|toast/i);
  });

  it('keeps the transaction behind injected modules', () => {
    const transactionSource = source('src/lib/aegis/core/AegisOutboundTransaction.ts');
    expect(transactionSource).toContain('deps.device.ensureReady');
    expect(transactionSource).toContain('deps.crypto.createMessage');
    expect(transactionSource).toContain('deps.routing.buildCopies');
    expect(transactionSource).toContain('deps.transport.sendWithRetry');
    expect(transactionSource).toContain('deps.queue.put');
    expect(transactionSource).not.toContain("@/integrations/supabase/client");
  });

  it('keeps call-key exchange outside the message queue', () => {
    const callsSource = source('src/lib/aegis/calls/index.ts');
    expect(callsSource).not.toMatch(/outbox|sendMessageWithAegisRetry/);
  });
});
""",
)

write(
    "docs/AEGIS_MODULES.md",
    """
# Aegis modular architecture

Aegis is split into explicit runtime modules. The first refactor preserves the
existing multi-device protocol, RPCs, durable outbox and LiveKit key format.

- `core`: orchestration, dependency injection, error model and outbox state machine.
- `device`: stable DeviceID readiness and conversation fingerprint trust.
- `crypto`: pure parent-envelope creation; no Supabase or UI imports.
- `routing`: canonical route fan-out and ratchet rollback.
- `transport`: long-message preparation and the atomic Aegis RPC.
- `queue`: encrypted local outbox, plaintext cache and conversation serialization.
- `recovery`: PIN backup and optional archive backup only. It does not repair routes.
- `calls`: LiveKit call-key wrapping, independent from the message outbox.
- `compatibility`: legacy envelope and per-device wire detection.

`src/lib/messaging/aegisOutboundEngine.ts` is retained as a compatibility
adapter. New code imports the public API from `@/lib/aegis`.

The outbound transaction receives `AegisRuntimeDependencies`; individual
modules can therefore be tested or replaced without rewriting the UI hook.
""",
)

print("Aegis modular refactor generated successfully")
