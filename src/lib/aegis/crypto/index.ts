
import { createAegisMessage } from '@/lib/messaging/aegisEnvelope';

/** Pure message-envelope crypto. No Supabase, React or UI dependency here. */
export const aegisCryptoModule = {
  createMessage: createAegisMessage,
} as const;

export type AegisCryptoModule = typeof aegisCryptoModule;

export { createAegisMessage };
