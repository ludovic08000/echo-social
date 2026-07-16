/**
 * Approved linked-device E2EE transfer.
 *
 * Sesame rule: a newly linked physical device receives account identity and
 * recoverable history, but keeps a unique DeviceID and creates fresh sessions,
 * device KX keys and prekeys. Old Double-Ratchet state must not be cloned from
 * iOS to Windows (or between two phones).
 */
import { useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { bufferToBase64, base64ToBuffer } from '@/lib/crypto/utils';
import { openE2EEDB } from '@/lib/crypto/indexedDb';
import { runTx, runTxOn, reqToPromise } from '@/lib/crypto/indexedDbTx';
import {
  buildDeviceLinkQrData,
  decryptDeviceLinkPayload,
  deviceLinkPublicKeysEqual,
  encryptDeviceLinkPayload,
  generateDeviceLinkKeyPair,
  generateDeviceLinkToken,
  hashDeviceLinkToken,
  parseDeviceLinkQrPayload,
  parseDeviceLinkToken,
  type DeviceLinkTransferEnvelope,
} from '@/lib/crypto/deviceLinkEnvelope';
import {
  exportArchiveMasterKeyForDeviceLink,
  importArchiveMasterKeyFromDeviceLink,
} from '@/lib/crypto/archiveMasterKey';
import { finalizeLinkedDeviceAfterRestore } from '@/lib/crypto/deviceLinkTrust';
import {
  getCurrentDeviceId,
  getCurrentDeviceLabel,
  getCurrentPlatform,
  hydrateDeviceId,
} from '@/lib/messaging/currentDevice';

const PBKDF2_ITERATIONS = 600_000;
const LINK_PRIVATE_KEY_PREFIX = 'forsure:device-link:private:';
const IDENTITY_STORE = 'identity-keys';

interface StoredLinkRequest {
  privateJwk: JsonWebKey;
  requesterDeviceId: string;
  createdAt: number;
}

interface CollectOptions {
  includeLegacySessions?: boolean;
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

function generatePin(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes).map((byte) => chars[byte % chars.length]).join('');
}

function persistPendingLink(token: string, request: StoredLinkRequest): void {
  try {
    sessionStorage.setItem(`${LINK_PRIVATE_KEY_PREFIX}${token}`, JSON.stringify(request));
  } catch {
    // Safari private mode can reject sessionStorage; recreate the QR if needed.
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
    window.dispatchEvent(new CustomEvent('forsure:e2ee-request-refanout-scan'));
  } catch {
    // SSR/tests
  }
}

async function readSideStore(dbKey: 'ratchet', storeName: string): Promise<any[]> {
  try {
    return await runTxOn(dbKey, [storeName], 'readonly', (tx) =>
      reqToPromise(tx.objectStore(storeName).getAll()),
    ) as any[];
  } catch {
    return [];
  }
}

async function writeSideStore(dbKey: 'ratchet', storeName: string, records: any[]): Promise<void> {
  if (!Array.isArray(records) || records.length === 0) return;
  try {
    await runTxOn(dbKey, [storeName], 'readwrite', (tx) => {
      const store = tx.objectStore(storeName);
      for (const record of records) store.put(record);
    });
  } catch {
    // Legacy session restore is best-effort only.
  }
}

/**
 * Collect account-scoped E2EE material. In the approved Sesame flow only the
 * account identity store is transferred. Session and prekey stores are
 * installation-specific and are deliberately excluded.
 */
async function collectLocalKeys(userId: string, options: CollectOptions = {}): Promise<string> {
  const includeLegacySessions = options.includeLegacySessions ?? false;
  const data: Record<string, any> = {};

  try {
    const db = await openE2EEDB();
    for (const storeName of Array.from(db.objectStoreNames)) {
      if (!includeLegacySessions && storeName !== IDENTITY_STORE) continue;

      let records = await runTx([storeName], 'readonly', (tx) =>
        reqToPromise(tx.objectStore(storeName).getAll() as IDBRequest<any[]>),
      ).catch(() => []);

      if (storeName === IDENTITY_STORE) {
        records = records.filter((record: any) =>
          !(typeof record?.id === 'string' && record.id.startsWith('device-kx::')),
        );
      }

      if (records.length > 0) data[`e2ee:${storeName}`] = records;
    }
  } catch {}

  // Only the explicitly legacy PIN payload keeps old ratchet state.
  if (includeLegacySessions) {
    const ratchets = await readSideStore('ratchet', 'ratchet-states');
    if (ratchets.length > 0) data['ratchet:states'] = ratchets;
  }

  const archiveMasterKey = await exportArchiveMasterKeyForDeviceLink(userId);
  if (archiveMasterKey) data['archive:master-key'] = archiveMasterKey;


  try {
    const fingerprints = localStorage.getItem('forsure-known-fps');
    if (fingerprints) data.fingerprints = fingerprints;
  } catch {}

  data._meta = {
    v: 3,
    mode: includeLegacySessions ? 'legacy' : 'sesame-fresh-device',
    createdAt: new Date().toISOString(),
  };

  return JSON.stringify(data);
}

/** Restore account material without adopting the source device's sessions. */
async function restoreLocalKeys(json: string, userId: string): Promise<void> {
  const data = JSON.parse(json) as Record<string, any>;
  const restoreLegacyDeviceState = data?._meta?.mode === 'legacy';

  for (const [key, records] of Object.entries(data)) {
    if (!key.startsWith('e2ee:') || !Array.isArray(records)) continue;
    const storeName = key.replace('e2ee:', '');
    if (!restoreLegacyDeviceState && storeName !== IDENTITY_STORE) continue;

    try {
      const db = await openE2EEDB();
      if (!db.objectStoreNames.contains(storeName)) continue;
      await runTx([storeName], 'readwrite', (tx) => {
        const store = tx.objectStore(storeName);
        for (const record of records) {
          if (
            storeName === IDENTITY_STORE &&
            typeof record?.id === 'string' &&
            record.id.startsWith('device-kx::')
          ) {
            continue;
          }
          store.put(record);
        }
      });
    } catch {}
  }

  if (restoreLegacyDeviceState && Array.isArray(data['ratchet:states'])) {
    await writeSideStore('ratchet', 'ratchet-states', data['ratchet:states']);
  }

  if (typeof data['archive:master-key'] === 'string') {
    const imported = await importArchiveMasterKeyFromDeviceLink(
      data['archive:master-key'],
      userId,
    );
    if (!imported) throw new Error('Cle archive du compte invalide');
  }


  if (typeof data.fingerprints === 'string') {
    localStorage.setItem('forsure-known-fps', data.fingerprints);
  }
}

export function useDeviceLink() {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createLinkRequest = useCallback(async (): Promise<{ qrData: string; token: string } | null> => {
    if (!user) { setError('Non authentifie'); return null; }
    setIsLoading(true);
    setError(null);

    try {
      const requesterDeviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
      const token = generateDeviceLinkToken();
      const tokenHash = await hashDeviceLinkToken(token);
      const pair = await generateDeviceLinkKeyPair();
      persistPendingLink(token, {
        privateJwk: pair.privateJwk,
        requesterDeviceId,
        createdAt: Date.now(),
      });

      const { error: rpcError } = await (supabase as any).rpc('create_device_link_request', {
        p_token_hash: tokenHash,
        p_requester_device_id: requesterDeviceId,
        p_requester_public_key: pair.publicJwk as any,
        p_requester_label: `${getCurrentDeviceLabel()} - ${getCurrentPlatform()}`,
      });
      if (rpcError) throw rpcError;

      return { qrData: buildDeviceLinkQrData(token, pair.publicJwk), token };
    } catch (err: any) {
      setError(err.message || 'Erreur de creation de demande');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const approveLinkRequest = useCallback(async (qrData: string): Promise<boolean> => {
    if (!user) { setError('Non authentifie'); return false; }
    setIsLoading(true);
    setError(null);

    try {
      const qr = parseDeviceLinkQrPayload(qrData);
      const token = qr.t;
      const tokenHash = await hashDeviceLinkToken(token);
      const currentDeviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());

      const { data, error: lookupError } = await (supabase as any).rpc('get_device_link_request_for_approval', {
        p_token_hash: tokenHash,
      });
      if (lookupError) throw lookupError;

      const request = Array.isArray(data) ? data[0] : data;
      if (!request) throw new Error('Demande expiree ou deja approuvee');
      if (request.requester_device_id === currentDeviceId) {
        throw new Error('Ouvre ce QR depuis un autre appareil deja connecte');
      }
      if (!deviceLinkPublicKeysEqual(request.requester_public_key as JsonWebKey, qr.pk as JsonWebKey)) {
        throw new Error('QR de liaison non authentifie: cle publique differente');
      }

      let keysJson = await collectLocalKeys(user.id);
      let envelope = await encryptDeviceLinkPayload(keysJson, request.requester_public_key as JsonWebKey);
      let encryptedPayload = JSON.stringify(envelope);

      if (encryptedPayload.length > 1_900_000) {
        keysJson = await collectLocalKeys(user.id);
        envelope = await encryptDeviceLinkPayload(keysJson, request.requester_public_key as JsonWebKey);
        encryptedPayload = JSON.stringify(envelope);
      }

      const { data: approved, error: approveError } = await (supabase as any).rpc('approve_device_link_request', {
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
      const { data, error: payloadError } = await (supabase as any).rpc('get_approved_device_link_payload', {
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
      await restoreLocalKeys(keysJson, user.id);

      const { error: completeError } = await (supabase as any).rpc('complete_device_link_request', {
        p_token_hash: tokenHash,
        p_requester_device_id: pending.requesterDeviceId,
      });
      if (completeError) throw completeError;

      const trusted = await finalizeLinkedDeviceAfterRestore(user.id, pending.requesterDeviceId);
      if (!trusted) {
        console.warn('[DeviceLink] device restored but signed-list publication is pending');
      }

      clearPendingLink(token);
      notifyKeysRestored('restored_from_linked_device');
      console.log('[DeviceLink] fresh Sesame device restored successfully');
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

  /** Legacy source-device flow kept for old QR/PIN links. */
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
      const keysJson = await collectLocalKeys(user.id, { includeLegacySessions: true });
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

  /** Legacy new-device claim for old QR/PIN links. */
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
      await restoreLocalKeys(keysJson, user.id);

      const currentDeviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
      void finalizeLinkedDeviceAfterRestore(user.id, currentDeviceId).catch(() => {});

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
    clearError: () => setError(null),
  };
}
