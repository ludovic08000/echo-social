/**
 * useE2EE - React hook for End-to-End Encryption
 * 
 * Manages key exchange, encryption/decryption of messages,
 * and key rotation for conversation security.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import {
  getOrCreateIdentityKeys,
  exportPublicKeyBundle,
  loadSessionKey,
  establishSession,
  encryptMessage,
  decryptMessage,
  isEncryptedMessage,
  needsKeyRotation,
  rotateSessionKey,
  incrementSessionMessageCount,
  type IdentityKeyPair,
} from '@/lib/crypto';

export interface E2EEState {
  ready: boolean;
  fingerprint: string | null;
  peerFingerprint: string | null;
  encrypted: boolean;
}

export function useE2EE(conversationId: string | undefined, peerUserId: string | undefined) {
  const { user } = useAuth();
  const [state, setState] = useState<E2EEState>({
    ready: false,
    fingerprint: null,
    peerFingerprint: null,
    encrypted: false,
  });
  const keysRef = useRef<IdentityKeyPair | null>(null);
  const peerKeyRef = useRef<{ identityKey: string; signingKey: string; fingerprint: string } | null>(null);
  const initRef = useRef(false);

  // Initialize: generate/load identity keys, publish public key
  useEffect(() => {
    if (!user || initRef.current) return;
    initRef.current = true;

    (async () => {
      try {
        // 1. Get or create identity key pair
        const keys = await getOrCreateIdentityKeys(user.id);
        keysRef.current = keys;

        // 2. Export and publish public key bundle
        const bundle = await exportPublicKeyBundle(keys);

        // 3. Upsert to user_public_keys table
        const { error } = await supabase
          .from('user_public_keys' as any)
          .upsert({
            user_id: user.id,
            identity_key: bundle.identityKey,
            signing_key: bundle.signingKey,
            fingerprint: bundle.fingerprint,
            kem_type: 'X25519',
            is_active: true,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id,is_active' });

        if (error) console.error('[E2EE] Failed to publish keys:', error);

        setState(s => ({ ...s, fingerprint: bundle.fingerprint }));
      } catch (err) {
        console.error('[E2EE] Init failed:', err);
      }
    })();
  }, [user]);

  // Fetch peer's public key when conversation/peer changes
  useEffect(() => {
    if (!peerUserId || !user) return;

    (async () => {
      try {
        const { data } = await supabase
          .from('user_public_keys' as any)
          .select('identity_key, signing_key, fingerprint')
          .eq('user_id', peerUserId)
          .eq('is_active', true)
          .maybeSingle();

        if (data) {
          peerKeyRef.current = {
            identityKey: (data as any).identity_key,
            signingKey: (data as any).signing_key,
            fingerprint: (data as any).fingerprint,
          };
          setState(s => ({
            ...s,
            peerFingerprint: (data as any).fingerprint,
            encrypted: true,
            ready: !!keysRef.current,
          }));
        } else {
          // Peer hasn't published keys yet — no E2EE
          setState(s => ({ ...s, encrypted: false, ready: true }));
        }
      } catch {
        setState(s => ({ ...s, encrypted: false, ready: true }));
      }
    })();
  }, [peerUserId, user]);

  // Establish session if needed
  const ensureSession = useCallback(async () => {
    if (!conversationId || !keysRef.current || !peerKeyRef.current) return null;

    let session = await loadSessionKey(conversationId);

    if (!session || await needsKeyRotation(conversationId)) {
      session = await (session
        ? rotateSessionKey(keysRef.current, peerKeyRef.current.identityKey, conversationId, peerKeyRef.current.fingerprint)
        : establishSession(keysRef.current, peerKeyRef.current.identityKey, conversationId, peerKeyRef.current.fingerprint)
      );
    }

    return session;
  }, [conversationId]);

  // Encrypt a message before sending
  const encrypt = useCallback(async (plaintext: string): Promise<string> => {
    if (!state.encrypted || !keysRef.current) return plaintext;

    try {
      const session = await ensureSession();
      if (!session) return plaintext;

      const seq = await incrementSessionMessageCount(conversationId!);
      const encrypted = await encryptMessage(
        plaintext,
        session.sharedSecret,
        keysRef.current.signingPrivateKey,
        keysRef.current.fingerprint,
        seq,
      );
      return encrypted;
    } catch (err) {
      console.error('[E2EE] Encrypt failed, sending plain:', err);
      return plaintext;
    }
  }, [state.encrypted, conversationId, ensureSession]);

  // Decrypt a message after receiving
  const decrypt = useCallback(async (body: string): Promise<{ text: string; encrypted: boolean; verified: boolean }> => {
    if (!isEncryptedMessage(body)) {
      return { text: body, encrypted: false, verified: false };
    }

    try {
      const session = await ensureSession();
      if (!session) return { text: '🔒 Message chiffré (clé manquante)', encrypted: true, verified: false };

      const result = await decryptMessage(
        body,
        session.sharedSecret,
        peerKeyRef.current?.signingKey,
      );
      return { text: result.plaintext, encrypted: true, verified: result.verified };
    } catch (err) {
      console.error('[E2EE] Decrypt failed:', err);
      return { text: '🔒 Impossible de déchiffrer ce message', encrypted: true, verified: false };
    }
  }, [ensureSession]);

  return {
    ...state,
    encrypt,
    decrypt,
  };
}
