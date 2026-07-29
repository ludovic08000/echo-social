
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
