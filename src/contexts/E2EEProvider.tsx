/**
 * E2EEProvider — Phase 2 split (Hybride)
 *
 * Owns ONE `useE2EE(conversationId, peerUserId)` instance per subtree and
 * exposes it via React context. Four facade hooks let consumers pick only
 * the slice they need, without ever creating duplicate ratchet instances:
 *
 *   - useE2EEBoot()         → boot / readiness state (mode, ready, error, fingerprint)
 *   - useE2EEEncrypt()      → encrypt + acknowledgeSentPayload
 *   - useE2EEDecrypt()      → decrypt
 *   - useE2EERatchetState() → isReady() + acknowledgeFingerprint + raw state
 *
 * Direct `useE2EE(...)` callers continue to work unchanged. This provider is
 * only required when a component tree needs to share the same instance across
 * several facade hooks.
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
  // Stable identity for context consumers (value already memoized internally
  // through useCallback/useState; we just forward it).
  const ctx = useMemo(() => value, [
    value.ready,
    value.mode,
    value.error,
    value.fingerprint,
    value.fingerprintChanged,
    value.previousFingerprint,
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
export function useE2EEBoot(): Pick<E2EEState, 'ready' | 'mode' | 'error' | 'fingerprint' | 'fingerprintChanged' | 'previousFingerprint'> {
  const { ready, mode, error, fingerprint, fingerprintChanged, previousFingerprint } =
    useE2EEContextOrThrow('useE2EEBoot');
  return { ready, mode, error, fingerprint, fingerprintChanged, previousFingerprint };
}

/** Outbound: encrypt + ack-sent. */
export function useE2EEEncrypt() {
  const { encrypt, acknowledgeSentPayload, ready, mode } = useE2EEContextOrThrow('useE2EEEncrypt');
  return { encrypt, acknowledgeSentPayload, ready, mode };
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
