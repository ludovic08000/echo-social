/**
 * Conversation Archive Key — long-life symmetric key per conversation,
 * wrapped under the account master key so any device that can unlock the
 * account (password / Backup PIN / Recovery Key) can re-read the full
 * message history. WhatsApp-style "encrypted history backup".
 *
 * Zero-access: the server only ever sees `wrapped_key` ciphertext. The
 * wrapping key (account master) never leaves the device unencrypted.
 *
 * This layer is COMPLEMENTARY to Double Ratchet — DR remains the primary
 * (forward-secret) channel; archive is the safety net that survives device
 * loss, cache purges and ghost-device quarantines.
 */
import { supabase } from '@/integrations/supabase/client';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { bufferToBase64, base64ToBuffer } from '@/lib/crypto/utils';
import { getSessionMasterKey } from '@/lib/crypto/accountKeyBackup';
import { isArchiveBackupEnabled } from '@/lib/messaging/archive/archivePrefs';

const ACTIVATED_FLAG = 'forsure:archive-activated-toast-shown:v1';

function maybeShowActivationToastOnce(): void {
  try {
    if (typeof window === 'undefined') return;
    if (localStorage.getItem(ACTIVATED_FLAG) === '1') return;
    localStorage.setItem(ACTIVATED_FLAG, '1');
    void import('sonner')
      .then(({ toast }) => {
        toast.success('Sauvegarde chiffrée d\u2019historique activ\u00e9e', {
          description: 'Vos messages restent lisibles sur tous vos appareils. Toujours chiffrés de bout en bout.',
          duration: 6000,
        });
      })
      .catch(() => {});
  } catch {
    /* swallow */
  }
}

const KDF_VERSION = 1;
const IV_LEN = 12;
const KEY_LEN = 32;

/** In-RAM cache of decrypted archive keys. Purged on session clear. */
const ramCache = new Map<string, CryptoKey>();

export function clearArchiveKeyCache(): void {
  ramCache.clear();
}

function dispatchArchiveKeysReady(userId: string, loaded: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
      detail: { reason: 'archive_keys_ready', userId, loaded },
    }));
  } catch {
    // UI wakeup is best-effort and carries metadata only.
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('forsure:e2ee-purge', clearArchiveKeyCache);
  window.addEventListener('forsure:e2ee-restore-needed', clearArchiveKeyCache);

  // Once the account Master Key is available, warm every conversation archive
  // key and wake pending bubbles. This is particularly important on Windows
  // after an iOS send (and vice versa): the parent row can already be mounted
  // before the account archive becomes decryptable.
  const preloadOnUnlock = (ev: Event) => {
    const detail = (ev as CustomEvent).detail || {};
    const uid = (detail as any).userId as string | undefined;
    if (!uid) return;
    void preloadAllArchiveKeys(uid)
      .then((loaded) => dispatchArchiveKeysReady(uid, loaded))
      .catch(() => {});
  };
  window.addEventListener('forsure:e2ee-unlocked', preloadOnUnlock);
  window.addEventListener('forsure:e2ee-post-restore', preloadOnUnlock);
}

interface ArchiveKeyRow {
  conversation_id: string;
  wrapped_key: string;
  kdf_version: number;
  created_at: string;
}

async function wrapKey(rawKey: Uint8Array, masterKey: CryptoKey, aad: Uint8Array): Promise<string> {
  const iv = hardCrypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, additionalData: aad.slice().buffer, tagLength: 128 },
    masterKey,
    rawKey.slice().buffer,
  );
  const combined = new Uint8Array(IV_LEN + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), IV_LEN);
  return bufferToBase64(combined.buffer);
}

async function unwrapKey(wrapped: string, masterKey: CryptoKey, aad: Uint8Array): Promise<Uint8Array> {
  const combined = new Uint8Array(base64ToBuffer(wrapped));
  if (combined.length <= IV_LEN) throw new Error('archive_key: wrapped payload too short');
  const iv = combined.slice(0, IV_LEN);
  const ct = combined.slice(IV_LEN);
  const pt = await hardCrypto.decrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, additionalData: aad.slice().buffer, tagLength: 128 },
    masterKey,
    ct.buffer,
  );
  return new Uint8Array(pt);
}

function aadFor(userId: string, convId: string): Uint8Array {
  return new hardGlobals.TextEncoder().encode(`forsure-conv-archive-v1:${userId}:${convId}`);
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return hardCrypto.importKey('raw', raw.slice().buffer, { name: 'AES-GCM' } as any, false, ['encrypt', 'decrypt']);
}

export async function getOrCreateArchiveKey(conversationId: string, userId: string): Promise<CryptoKey | null> {
  const cacheKey = `${userId}:${conversationId}`;
  const cached = ramCache.get(cacheKey);
  if (cached) return cached;

  const masterKey = getSessionMasterKey();
  if (!masterKey) return null;

  const aad = aadFor(userId, conversationId);

  try {
    const { data } = await supabase
      .from('conversation_archive_keys' as any)
      .select('wrapped_key, kdf_version')
      .eq('conversation_id', conversationId)
      .eq('user_id', userId)
      .maybeSingle();

    if (data && (data as any).wrapped_key) {
      const raw = await unwrapKey((data as any).wrapped_key, masterKey, aad);
      const ck = await importAesKey(raw);
      raw.fill(0);
      ramCache.set(cacheKey, ck);
      return ck;
    }
  } catch {
    /* fall through to creation */
  }

  try {
    const raw = hardCrypto.getRandomValues(new Uint8Array(KEY_LEN));
    const wrapped = await wrapKey(raw, masterKey, aad);

    const { error } = await supabase
      .from('conversation_archive_keys' as any)
      .upsert({
        conversation_id: conversationId,
        user_id: userId,
        wrapped_key: wrapped,
        kdf_version: KDF_VERSION,
      }, { onConflict: 'conversation_id,user_id', ignoreDuplicates: true });

    if (error) {
      raw.fill(0);
      return null;
    }

    const { data: existing } = await supabase
      .from('conversation_archive_keys' as any)
      .select('wrapped_key')
      .eq('conversation_id', conversationId)
      .eq('user_id', userId)
      .maybeSingle();

    raw.fill(0);
    if (!existing || !(existing as any).wrapped_key) return null;

    const storedRaw = await unwrapKey((existing as any).wrapped_key, masterKey, aad);
    const ck = await importAesKey(storedRaw);
    storedRaw.fill(0);
    ramCache.set(cacheKey, ck);
    maybeShowActivationToastOnce();
    return ck;
  } catch {
    return null;
  }
}

export interface ArchivePayload {
  v: 1;
  iv: string;
  ct: string;
}

export function isArchivePayload(s: string | null | undefined): boolean {
  if (!s) return false;
  try {
    const o = JSON.parse(s);
    return o?.v === 1 && typeof o.iv === 'string' && typeof o.ct === 'string';
  } catch {
    return false;
  }
}

export async function encryptArchive(plaintext: string, conversationId: string, userId: string): Promise<string | null> {
  if (!plaintext || !isArchiveBackupEnabled()) return null;
  const key = await getOrCreateArchiveKey(conversationId, userId);
  if (!key) return null;
  try {
    const iv = hardCrypto.getRandomValues(new Uint8Array(IV_LEN));
    const ct = await hardCrypto.encrypt(
      { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 },
      key,
      new hardGlobals.TextEncoder().encode(plaintext),
    );
    const payload: ArchivePayload = {
      v: 1,
      iv: bufferToBase64(iv.buffer as ArrayBuffer),
      ct: bufferToBase64(ct as ArrayBuffer),
    };
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

export async function decryptArchive(archiveBody: string, conversationId: string, userId: string): Promise<string | null> {
  if (!isArchivePayload(archiveBody)) return null;
  const key = await getOrCreateArchiveKey(conversationId, userId);
  if (!key) return null;
  try {
    const parsed = JSON.parse(archiveBody) as ArchivePayload;
    const iv = new Uint8Array(base64ToBuffer(parsed.iv));
    const ct = base64ToBuffer(parsed.ct);
    const pt = await hardCrypto.decrypt(
      { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 },
      key,
      ct,
    );
    return new hardGlobals.TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export async function preloadAllArchiveKeys(userId: string): Promise<number> {
  const masterKey = getSessionMasterKey();
  if (!masterKey) return 0;
  try {
    const { data } = await supabase.rpc('get_user_archive_keys' as any);
    const rows = (data || []) as ArchiveKeyRow[];
    let loaded = 0;
    for (const row of rows) {
      const cacheKey = `${userId}:${row.conversation_id}`;
      if (ramCache.has(cacheKey)) continue;
      try {
        const raw = await unwrapKey(row.wrapped_key, masterKey, aadFor(userId, row.conversation_id));
        const ck = await importAesKey(raw);
        raw.fill(0);
        ramCache.set(cacheKey, ck);
        loaded++;
      } catch {
        /* one archive key may belong to an obsolete account key */
      }
    }
    return loaded;
  } catch {
    return 0;
  }
}

function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function setMessageArchiveBody(
  messageId: string,
  archiveBody: string,
): Promise<boolean> {
  if (!messageId || !archiveBody || !archiveBody.trim()) return false;

  const delays = [0, 500, 2_000];
  let lastError: string | null = null;

  for (const delay of delays) {
    await wait(delay);
    try {
      const { data, error } = await supabase.rpc('set_message_archive_body' as any, {
        p_message_id: messageId,
        p_archive_body: archiveBody,
      });
      if (!error && data) return true;
      lastError = error?.message ?? 'archive_write_not_applied';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  console.warn('[archive] setMessageArchiveBody failed after retries', {
    messageId: messageId.slice(0, 8),
    attempts: delays.length,
    error: lastError,
  });
  return false;
}
