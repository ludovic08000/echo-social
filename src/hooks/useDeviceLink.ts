/**
 * useDeviceLink - approved linked-device E2EE transfer.
 *
 * New flow (Signal-style shape):
 *   1. The new device creates a short-lived QR request containing a token and
 *      its ephemeral public key.
 *   2. The already-connected device approves that token.
 *   3. The approver verifies the server row still matches the QR public key,
 *      then encrypts local keys + decryptable history cache to that key.
 *   4. The new device decrypts locally, restores IndexedDB, then triggers resync.
 *
 * The legacy PIN flow is kept for backwards compatibility with old links, but
 * the UI now uses the approval flow by default.
 */

import { useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { bufferToBase64, base64ToBuffer } from '@/lib/crypto/utils';
import { STORE_KEYS, STORE_PREKEYS, STORE_SESSION } from '@/lib/crypto/constants';
import { reqToPromise, runTxOn } from '@/lib/crypto/indexedDbTx';
import {
  buildDeviceLinkQrData,
  decryptDeviceLinkPayload,
  encryptDeviceLinkPayload,
  fingerprintDeviceLinkPublicKey,
  generateDeviceLinkKeyPair,
  generateDeviceLinkToken,
  hashDeviceLinkToken,
  parseDeviceLinkQrData,
  parseDeviceLinkToken,
  verifyDeviceLinkQrKeyBinding,
  type DeviceLinkTransferEnvelope,
} from '@/lib/crypto/deviceLinkEnvelope';
import {
  getCurrentDeviceId,
  getCurrentDeviceLabel,
  getCurrentPlatform,
  hydrateDeviceId,
} from '@/lib/messaging/currentDevice';
import {
  exportPlaintextCache,
  importPlaintextCache,
  type PlaintextCacheExportEntry,
} from '@/lib/crypto/plaintextStore';

const PBKDF2_ITERATIONS = 600_000;
const LINK_PRIVATE_KEY_PREFIX = 'forsure:device-link:private:';
const E2EE_STORES = [STORE_KEYS, STORE_SESSION, STORE_PREKEYS] as const;

interface StoredLinkRequest {
  privateJwk: JsonWebKey;
  publicJwk?: JsonWebKey;
  publicKeyHash?: string;
  requesterDeviceId: string;
  createdAt: number;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Generate a random 8-character alphanumeric PIN for legacy links. */
function generatePin(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

function persistPendingLink(token: string, request: StoredLinkRequest): void {
  try {
    sessionStorage.setItem(`${LINK_PRIVATE_KEY_PREFIX}${token}`, JSON.stringify(request));
  } catch {
    // Safari private mode can reject sessionStorage; the user can recreate a QR.
  }
}

function loadPendingLink(token: string): StoredLinkRequest | null {
  try {
    const raw = sessionStorage.getItem(`${LINK_PRIVATE_KEY_PREFIX}${token}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredLinkRequest;
    if (!parsed?.privateJwk || !parsed.requesterDeviceId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearPendingLink(token: string): void {
  try { sessionStorage.removeItem(`${LINK_PRIVATE_KEY_PREFIX}${token}`); } catch {}
}

function notifyKeysRestored(status: string): void {
  try {
    window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
      detail: { status, source: 'device_link' },
    }));
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry'));
  } catch {
    // SSR/tests
  }
}

/** Collect all local E2EE state plus, when possible, the local plaintext cache. */
async function collectLocalKeys(options: { includePlaintextCache?: boolean } = {}): Promise<string> {
  const includePlaintextCache = options.includePlaintextCache ?? true;
  const data: Record<string, any> = {};

  for (const storeName of E2EE_STORES) {
    try {
      data[`e2ee:${storeName}`] = await runTxOn('e2ee', storeName, 'readonly', (store) =>
        reqToPromise<any[]>(store.getAll()),
      );
    } catch {}
  }

  try {
    const all = await runTxOn('ratchet', 'ratchet-states', 'readonly', (store) => {
      return reqToPromise<any[]>(store.getAll());
    });
    if (all.length > 0) data['ratchet:states'] = all;
  } catch {}

  if (includePlaintextCache) {
    try {
      const plaintextCache = await exportPlaintextCache();
      if (plaintextCache.length > 0) data['plaintext:cache'] = plaintextCache;
    } catch {}
  }

  try {
    const fps = localStorage.getItem('forsure-known-fps');
    if (fps) data['fingerprints'] = fps;
  } catch {}

  return JSON.stringify(data);
}

/** Restore keys from JSON into local stores. */
async function restoreLocalKeys(json: string): Promise<void> {
  const data = JSON.parse(json);

  for (const [key, records] of Object.entries(data)) {
    if (!key.startsWith('e2ee:') || !Array.isArray(records)) continue;
    const storeName = key.replace('e2ee:', '');
    if (!E2EE_STORES.includes(storeName as (typeof E2EE_STORES)[number])) continue;
    try {
      await runTxOn('e2ee', storeName, 'readwrite', (store) => {
        for (const record of records) store.put(record);
      });
    } catch {}
  }

  if (data['ratchet:states'] && Array.isArray(data['ratchet:states'])) {
    try {
      await runTxOn('ratchet', 'ratchet-states', 'readwrite', (store) => {
        for (const r of data['ratchet:states']) store.put(r);
      });
    } catch {}
  }

  if (Array.isArray(data['plaintext:cache'])) {
    await importPlaintextCache(data['plaintext:cache'] as PlaintextCacheExportEntry[]);
  }

  if (data['fingerprints']) {
    localStorage.setItem('forsure-known-fps', data['fingerprints']);
  }
}

export function useDeviceLink() {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * New device: create an approval request QR. The private key never leaves
   * this browser and is held only in sessionStorage until claim/expiry.
   */
  const createLinkRequest = useCallback(async (): Promise<{ qrData: string; token: string } | null> => {
    if (!user) { setError('Non authentifie'); return null; }
    setIsLoading(true);
    setError(null);

    try {
      const requesterDeviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
      const token = generateDeviceLinkToken();
      const tokenHash = await hashDeviceLinkToken(token);
      const pair = await generateDeviceLinkKeyPair();
      const publicKeyHash = await fingerprintDeviceLinkPublicKey(pair.publicJwk);
      persistPendingLink(token, {
        privateJwk: pair.privateJwk,
        publicJwk: pair.publicJwk,
        publicKeyHash,
        requesterDeviceId,
        createdAt: Date.now(),
      });

      const { error: rpcError } = await supabase.rpc('create_device_link_request', {
        p_token_hash: tokenHash,
        p_requester_device_id: requesterDeviceId,
        p_requester_public_key: pair.publicJwk as any,
        p_requester_label: `${getCurrentDeviceLabel()} - ${getCurrentPlatform()}`,
      });
      if (rpcError) throw rpcError;

      return { qrData: buildDeviceLinkQrData(token, pair.publicJwk, publicKeyHash), token };
    } catch (err: any) {
      setError(err.message || 'Erreur de creation de demande');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  /**
   * Existing device: approve a QR request and upload the encrypted initial
   * transfer for that exact requester key.
   */
  const approveLinkRequest = useCallback(async (qrData: string): Promise<boolean> => {
    if (!user) { setError('Non authentifie'); return false; }
    setIsLoading(true);
    setError(null);

    try {
      const parsedQr = parseDeviceLinkQrData(qrData);
      if (!parsedQr.requesterPublicJwk) {
        throw new Error('QR non authentifie: regenere une demande de liaison securisee');
      }
      const token = parsedQr.token;
      const tokenHash = await hashDeviceLinkToken(token);
      const currentDeviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());

      const { data, error: lookupError } = await supabase.rpc('get_device_link_request_for_approval', {
        p_token_hash: tokenHash,
      });
      if (lookupError) throw lookupError;

      const request = Array.isArray(data) ? data[0] : data;
      if (!request) throw new Error('Demande expiree ou deja approuvee');
      if (request.requester_device_id === currentDeviceId) {
        throw new Error('Ouvre ce QR depuis un autre appareil deja connecte');
      }
      await verifyDeviceLinkQrKeyBinding(parsedQr, request.requester_public_key as JsonWebKey);

      let keysJson = await collectLocalKeys();
      let envelope = await encryptDeviceLinkPayload(keysJson, parsedQr.requesterPublicJwk);
      let encryptedPayload = JSON.stringify(envelope);

      if (encryptedPayload.length > 1_900_000) {
        keysJson = await collectLocalKeys({ includePlaintextCache: false });
        envelope = await encryptDeviceLinkPayload(keysJson, parsedQr.requesterPublicJwk);
        encryptedPayload = JSON.stringify(envelope);
      }

      const { data: approved, error: approveError } = await supabase.rpc('approve_device_link_request', {
        p_token_hash: tokenHash,
        p_approver_device_id: currentDeviceId,
        p_encrypted_payload: encryptedPayload,
      });
      if (approveError) throw approveError;
      if (!approved) throw new Error('Demande impossible a approuver');

      return true;
    } catch (err: any) {
      setError(err.message || 'Erreur d approbation');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  /**
   * New device: fetch the approved ciphertext, decrypt with the local private
   * key from the original request, restore, then mark the request complete.
   */
  const claimApprovedLink = useCallback(async (qrData: string): Promise<boolean> => {
    if (!user) { setError('Non authentifie'); return false; }
    setIsLoading(true);
    setError(null);

    try {
      const token = parseDeviceLinkToken(qrData);
      const pending = loadPendingLink(token);
      if (!pending) {
        throw new Error('Demande introuvable sur cet appareil. Regenere un QR ici.');
      }

      const tokenHash = await hashDeviceLinkToken(token);
      const { data, error: payloadError } = await supabase.rpc('get_approved_device_link_payload', {
        p_token_hash: tokenHash,
        p_requester_device_id: pending.requesterDeviceId,
      });
      if (payloadError) throw payloadError;

      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.encrypted_payload) {
        throw new Error('En attente d approbation depuis un autre appareil');
      }

      const envelope = JSON.parse(row.encrypted_payload) as DeviceLinkTransferEnvelope;
      const keysJson = await decryptDeviceLinkPayload(envelope, pending.privateJwk);
      await restoreLocalKeys(keysJson);

      await supabase.rpc('complete_device_link_request', {
        p_token_hash: tokenHash,
        p_requester_device_id: pending.requesterDeviceId,
      });

      clearPendingLink(token);
      notifyKeysRestored('restored_from_linked_device');
      console.log('[DeviceLink] linked-device keys restored successfully');
      return true;
    } catch (err: any) {
      if (err.name === 'OperationError') {
        setError('Transfert chiffre illisible pour cet appareil');
      } else {
        setError(err.message || 'Erreur de recuperation');
      }
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  /**
   * Legacy source-device flow kept for old QR/PIN links.
   */
  const createLink = useCallback(async (): Promise<{ qrData: string; pin: string } | null> => {
    if (!user) { setError('Non authentifie'); return null; }
    setIsLoading(true);
    setError(null);

    try {
      const { data: tokenData, error: fnError } = await supabase.functions.invoke(
        'device-link',
        { body: { action: 'create' } },
      );
      if (fnError) throw fnError;

      const token = tokenData.token as string;
      const pin = generatePin();
      const keysJson = await collectLocalKeys();
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveKey(pin, salt);
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(keysJson),
      );

      const payload = JSON.stringify({
        ct: bufferToBase64(ciphertext),
        salt: bufferToBase64(salt.buffer),
        iv: bufferToBase64(iv.buffer),
      });

      const { error: uploadError } = await supabase.functions.invoke(
        'device-link',
        { body: { action: 'upload', encrypted_payload: payload } },
      );
      if (uploadError) throw uploadError;

      return { qrData: JSON.stringify({ t: token }), pin };
    } catch (err: any) {
      setError(err.message || 'Erreur de liaison');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  /**
   * Legacy new-device claim for old QR/PIN links.
   */
  const claimLink = useCallback(async (qrData: string, pin: string): Promise<boolean> => {
    if (!user) { setError('Non authentifie'); return false; }
    setIsLoading(true);
    setError(null);

    try {
      const { t: token } = JSON.parse(qrData);
      const { data: claimData, error: claimError } = await supabase.functions.invoke(
        'device-link',
        { body: { action: 'claim', token } },
      );
      if (claimError) throw claimError;

      const envelope = JSON.parse(claimData.encrypted_payload);
      const salt = new Uint8Array(base64ToBuffer(envelope.salt));
      const iv = new Uint8Array(base64ToBuffer(envelope.iv));
      const ct = base64ToBuffer(envelope.ct);
      const key = await deriveKey(pin, salt);
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      const keysJson = new TextDecoder().decode(plainBuf);
      await restoreLocalKeys(keysJson);

      notifyKeysRestored('restored_from_legacy_device_link');
      console.log('[DeviceLink] legacy keys restored successfully');
      return true;
    } catch (err: any) {
      if (err.name === 'OperationError') {
        setError('Code PIN incorrect ou token expire');
      } else {
        setError(err.message || 'Erreur de recuperation');
      }
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  return {
    createLinkRequest,
    approveLinkRequest,
    claimApprovedLink,
    createLink,
    claimLink,
    isLoading,
    error,
  };
}
