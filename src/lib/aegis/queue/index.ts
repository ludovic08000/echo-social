
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
