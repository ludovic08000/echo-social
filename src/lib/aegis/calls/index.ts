
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
