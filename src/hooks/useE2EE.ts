/**
 * Account identity and trust gate for Sesame-lite.
 *
 * Message encryption does not live in this hook. Sesame-lite owns exactly one
 * Double Ratchet session per local-device/remote-device pair and sends only
 * device-targeted copies through the atomic message RPC.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import {
  exportPublicKeyBundle,
  getOrCreateIdentityKeys,
  refreshSignedPrekeyIfNeeded,
  type IdentityKeyPair,
} from '@/lib/crypto';
import { PinUnlockRequiredError } from '@/lib/crypto/keyManager';
import {
  checkFingerprintChangeWithServer,
  invalidateFingerprintCheckCache,
  saveKnownFingerprint,
  saveKnownFingerprintServer,
} from '@/lib/crypto/fingerprintTracker';
import {
  _peerKeyCache,
  fetchPeerPublicKeys,
  primeAuthUserId,
} from '@/lib/crypto/peerKeyCache';
import {
  isCryptoJsonBody,
  isUnsupportedEncryptedBody,
} from '@/lib/messaging/messageCompatibility';

const ZEUS_ID = '00000000-0000-0000-0000-000000000001';

type IdentityWithMetadata = IdentityKeyPair & { isNewIdentity?: boolean };

type ReadyIdentity = {
  keys: IdentityKeyPair;
  fingerprint: string;
};

const identityInitialization = new Map<string, Promise<ReadyIdentity>>();

async function initializeIdentity(userId: string): Promise<ReadyIdentity> {
  const active = identityInitialization.get(userId);
  if (active) return active;

  const initialization = (async () => {
    primeAuthUserId(userId);
    const keysResult = await getOrCreateIdentityKeys(userId);
    const keys: IdentityKeyPair = keysResult;
    const bundle = await exportPublicKeyBundle(keys);

    const { data: existingKey, error: existingKeyError } = await supabase
      .from('user_public_keys')
      .select('fingerprint')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();

    if (existingKeyError) throw existingKeyError;

    const isNewIdentity = (keysResult as IdentityWithMetadata).isNewIdentity === true;
    if (isNewIdentity && existingKey && existingKey.fingerprint !== bundle.fingerprint) {
      window.dispatchEvent(new CustomEvent('forsure-identity-lost', {
        detail: {
          hasBackup: true,
          serverFingerprint: existingKey.fingerprint,
        },
      }));
      throw new Error('identity_lost_backup_available');
    }

    const { error: publishError } = await supabase
      .from('user_public_keys')
      .upsert({
        user_id: userId,
        identity_key: bundle.identityKey,
        signing_key: bundle.signingKey,
        fingerprint: bundle.fingerprint,
        kem_type: 'X25519',
        is_active: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,is_active' });

    if (publishError) throw publishError;

    void refreshSignedPrekeyIfNeeded(userId, keys.signingPrivateKey).catch(error => {
      console.warn('[SESAME_LITE] signed prekey refresh failed', error);
    });
    void supabase.rpc('push_my_fingerprint_to_peers');

    return { keys, fingerprint: bundle.fingerprint };
  })().catch(error => {
    identityInitialization.delete(userId);
    throw error;
  });

  identityInitialization.set(userId, initialization);
  return initialization;
}

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

export interface E2EEState {
  ready: boolean;
  fingerprint: string | null;
  peerFingerprint: string | null;
  encrypted: boolean;
  ratchetActive: boolean;
  fingerprintChanged: boolean;
  peerKeyMissing: boolean;
  initError: string | null;
}

export interface DecryptResult {
  text: string;
  encrypted: boolean;
  verified: boolean;
  incompatible?: boolean;
}

const INITIAL_STATE: E2EEState = {
  ready: false,
  fingerprint: null,
  peerFingerprint: null,
  encrypted: false,
  ratchetActive: false,
  fingerprintChanged: false,
  peerKeyMissing: false,
  initError: null,
};

function initializationErrorCode(error: unknown): string {
  if (error instanceof PinUnlockRequiredError) return 'pin_unlock_required';
  if (error instanceof Error && error.message === 'identity_lost_backup_available') {
    return 'identity_lost_backup_available';
  }
  return 'key_initialization_failed';
}

export function useE2EE(_conversationId: string | undefined, peerUserId: string | undefined) {
  const { user } = useAuth();
  const [state, setState] = useState<E2EEState>(INITIAL_STATE);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const isZeus = peerUserId === ZEUS_ID;

  const requestRefresh = useCallback((clearCaches: boolean) => {
    if (clearCaches && peerUserId) {
      _peerKeyCache.delete(peerUserId);
      invalidateFingerprintCheckCache(peerUserId);
    }
    setRefreshEpoch(epoch => epoch + 1);
  }, [peerUserId]);

  useEffect(() => {
    if (!user) {
      setState(INITIAL_STATE);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const ownIdentity = await initializeIdentity(user.id);
        if (cancelled) return;

        if (!peerUserId || isZeus) {
          setState({
            ...INITIAL_STATE,
            ready: true,
            fingerprint: ownIdentity.fingerprint,
          });
          return;
        }

        const peerKey = await fetchPeerPublicKeys(peerUserId);
        if (cancelled) return;

        if (!peerKey) {
          setState({
            ...INITIAL_STATE,
            fingerprint: ownIdentity.fingerprint,
            peerKeyMissing: true,
            initError: 'peer_key_missing',
          });
          return;
        }

        const fingerprintCheck = await checkFingerprintChangeWithServer(
          user.id,
          peerUserId,
          peerKey.fingerprint,
        );
        if (cancelled) return;

        if (fingerprintCheck.changed) {
          setState({
            ready: false,
            fingerprint: ownIdentity.fingerprint,
            peerFingerprint: peerKey.fingerprint,
            encrypted: true,
            ratchetActive: false,
            fingerprintChanged: true,
            peerKeyMissing: false,
            initError: 'fingerprint_changed',
          });
          return;
        }

        saveKnownFingerprint(peerUserId, peerKey.fingerprint);
        void saveKnownFingerprintServer(peerUserId, peerKey.fingerprint);
        setState({
          ready: true,
          fingerprint: ownIdentity.fingerprint,
          peerFingerprint: peerKey.fingerprint,
          encrypted: true,
          ratchetActive: true,
          fingerprintChanged: false,
          peerKeyMissing: false,
          initError: null,
        });
      } catch (error) {
        if (cancelled) return;
        const initError = initializationErrorCode(error);
        setState(previous => ({
          ...previous,
          ready: false,
          ratchetActive: false,
          initError,
        }));
        if (initError === 'pin_unlock_required') {
          window.dispatchEvent(new CustomEvent('forsure-pin-required-for-keys'));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isZeus, peerUserId, refreshEpoch, user]);

  useEffect(() => {
    if (!user) return;

    const onUnlockedOrRestored = () => {
      identityInitialization.delete(user.id);
      requestRefresh(true);
    };
    const onLocked = () => {
      identityInitialization.delete(user.id);
      setState(previous => ({
        ...previous,
        ready: false,
        ratchetActive: false,
        initError: 'pin_unlock_required',
      }));
    };
    const onRouteReady = () => requestRefresh(true);
    const onOnline = () => requestRefresh(true);

    window.addEventListener('forsure-keys-unlocked', onUnlockedOrRestored);
    window.addEventListener('forsure-keys-restored', onUnlockedOrRestored);
    window.addEventListener('forsure-keys-locked', onLocked);
    window.addEventListener('forsure:sesame-route-ready', onRouteReady);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('forsure-keys-unlocked', onUnlockedOrRestored);
      window.removeEventListener('forsure-keys-restored', onUnlockedOrRestored);
      window.removeEventListener('forsure-keys-locked', onLocked);
      window.removeEventListener('forsure:sesame-route-ready', onRouteReady);
      window.removeEventListener('online', onOnline);
    };
  }, [requestRefresh, user]);

  const acknowledgeFingerprint = useCallback(async () => {
    if (!peerUserId || !state.peerFingerprint) return;
    saveKnownFingerprint(peerUserId, state.peerFingerprint);
    await saveKnownFingerprintServer(peerUserId, state.peerFingerprint, true);
    invalidateFingerprintCheckCache(peerUserId);
    setState(previous => ({
      ...previous,
      ready: true,
      encrypted: true,
      ratchetActive: true,
      fingerprintChanged: false,
      peerKeyMissing: false,
      initError: null,
    }));
    window.dispatchEvent(new CustomEvent('forsure:sesame-route-ready', {
      detail: { peerUserId },
    }));
  }, [peerUserId, state.peerFingerprint]);

  const encrypt = useCallback(async (
    _plaintext: string,
    _localId?: string,
  ): Promise<string> => {
    throw new EncryptionError('Le chiffrement direct est désactivé : utilisez Sesame-lite.');
  }, []);

  const decrypt = useCallback(async (body: string): Promise<DecryptResult> => {
    if (!isCryptoJsonBody(body) && !isUnsupportedEncryptedBody(body)) {
      return { text: body, encrypted: false, verified: false };
    }
    return { text: '', encrypted: true, verified: false, incompatible: true };
  }, []);

  const isReady = useCallback(() => (
    isZeus || (
      state.ready &&
      state.encrypted &&
      !state.fingerprintChanged &&
      !state.peerKeyMissing &&
      state.initError === null
    )
  ), [isZeus, state]);

  const acknowledgeSentPayload = useCallback((_localId: string): Promise<void> => (
    Promise.resolve()
  ), []);

  return useMemo(() => ({
    ...state,
    encrypt,
    decrypt,
    isReady,
    acknowledgeFingerprint,
    acknowledgeSentPayload,
  }), [
    acknowledgeFingerprint,
    acknowledgeSentPayload,
    decrypt,
    encrypt,
    isReady,
    state,
  ]);
}
