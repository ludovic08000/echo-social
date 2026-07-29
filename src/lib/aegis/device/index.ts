
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
