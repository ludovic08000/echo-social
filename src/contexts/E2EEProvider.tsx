/**
 * E2EEProvider — Phase 2 split (Hybride)
 *
 * Owns ONE `useE2EE(conversationId, peerUserId)` instance per subtree and
 * exposes it via React context. Four facade hooks let consumers pick only
 * the slice they need, without ever creating duplicate ratchet instances.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useE2EE, type E2EEState, type DecryptResult } from '@/hooks/useE2EE';

type E2EEContextValue = ReturnType<typeof useE2EE>;

const E2EEContext = createContext<E2EEContextValue | null>(null);

export interface E2EEProviderProps {
  conversationId: string | undefined;
  peerUserId: string | undefined;
  children: ReactNode;
}

export function E2EEProvider({ conversationId, peerUserId, children }: E2EEProviderProps) {
  const value = useE2EE(conversationId, peerUserId);
  const ctx = useMemo(() => value, [
    value.ready,
    value.fingerprint,
    value.peerFingerprint,
    value.encrypted,
    value.ratchetActive,
    value.fingerprintChanged,
    value.peerKeyMissing,
    value.initError,
    value.encrypt,
    value.decrypt,
    value.isReady,
    value.acknowledgeFingerprint,
    value.acknowledgeSentPayload,
  ]);
  return <E2EEContext.Provider value={ctx}>{children}</E2EEContext.Provider>;
}

function useE2EEContextOrThrow(hookName: string): E2EEContextValue {
  const ctx = useContext(E2EEContext);
  if (!ctx) {
    throw new Error(
      `${hookName}() must be used inside <E2EEProvider conversationId peerUserId>. ` +
      `If you need a standalone instance, call useE2EE(conversationId, peerUserId) directly.`
    );
  }
  return ctx;
}

/** Boot / readiness slice — what UI needs to show "secure" badges & errors. */
export function useE2EEBoot(): Pick<
  E2EEState,
  'ready' | 'encrypted' | 'ratchetActive' | 'initError' | 'fingerprint' | 'peerFingerprint' | 'fingerprintChanged' | 'peerKeyMissing'
> {
  const {
    ready, encrypted, ratchetActive, initError,
    fingerprint, peerFingerprint, fingerprintChanged, peerKeyMissing,
  } = useE2EEContextOrThrow('useE2EEBoot');
  return { ready, encrypted, ratchetActive, initError, fingerprint, peerFingerprint, fingerprintChanged, peerKeyMissing };
}

/** Outbound: encrypt + ack-sent. */
export function useE2EEEncrypt() {
  const { encrypt, acknowledgeSentPayload, ready, ratchetActive } = useE2EEContextOrThrow('useE2EEEncrypt');
  return { encrypt, acknowledgeSentPayload, ready, ratchetActive };
}

/** Inbound: decrypt only. */
export function useE2EEDecrypt(): {
  decrypt: (body: string) => Promise<DecryptResult>;
  ready: boolean;
} {
  const { decrypt, ready } = useE2EEContextOrThrow('useE2EEDecrypt');
  return { decrypt, ready };
}

/** Ratchet state controls (readiness probe + fingerprint ack). */
export function useE2EERatchetState() {
  const { isReady, acknowledgeFingerprint, fingerprint, fingerprintChanged } =
    useE2EEContextOrThrow('useE2EERatchetState');
  return { isReady, acknowledgeFingerprint, fingerprint, fingerprintChanged };
}

/** Escape hatch: full context value (advanced). */
export function useE2EEFull(): E2EEContextValue {
  return useE2EEContextOrThrow('useE2EEFull');
}
