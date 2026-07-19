/**
 * Conversation Archive Key — long-life symmetric key per conversation,
 * wrapped under the convergent account archive Master Key so every linked
 * device can re-read the same encrypted history.
 *
 * Double Ratchet remains the primary forward-secret channel. This layer is a
 * zero-access recovery path: the server sees only wrapped keys and ciphertext.
 */
import { supabase } from '@/integrations/supabase/client';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { bufferToBase64, base64ToBuffer } from '@/lib/crypto/utils';
import { getArchiveMasterKey } from '@/lib/crypto/archiveMasterKey';
import { isArchiveBackupEnabled } from '@/lib/messaging/archive/archivePrefs';

const ACTIVATED_FLAG = 'forsure:archive-activated-toast-shown:v1';
const KDF_VERSION = 1;
const IV_LEN = 12;
const KEY_LEN = 32;

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

/** In-RAM cache of decrypted conversation archive keys. */
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

  const preloadOnUnlock = (event: Event) => {
    const detail = (event as CustomEvent).detail || {};
    const userId = (detail as any).userId as string | undefined;
    if (!userId) return;
    void preloadAllArchiveKeys(userId)
      .then((loaded) => dispatchArchiveKeysReady(userId, loaded))
      .catch(() => {});
  };

  window.addEventListener('forsure:e2ee-unlocked', preloadOnUnlock);
  window.addEventListener('forsure:e2ee-post-restore', preloadOnUnlock);
  window.addEventListener('forsure:archive-master-ready', preloadOnUnlock);
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
    {
      name: 'AES-GCM',
      iv: iv as Uint8Array<ArrayBuffer>,
      additionalData: aad.buffer.slice(aad.byteOffset, aad.byteOffset + aad.byteLength),
      tagLength: 128,
    },
    masterKey,
    rawKey.buffer.slice(rawKey.byteOffset, rawKey.byteOffset + rawKey.byteLength),
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
    {
      name: 'AES-GCM',
      iv: iv as Uint8Array<ArrayBuffer>,
      additionalData: aad.buffer.slice(aad.byteOffset, aad.byteOffset + aad.byteLength),
      tagLength: 128,
    },
    masterKey,
    ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength),
  );
  return new Uint8Array(pt);
}

function aadFor(userId: string, conversationId: string): Uint8Array {
  return new hardGlobals.TextEncoder().encode(`forsure-conv-archive-v1:${userId}:${conversationId}`);
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return hardCrypto.importKey(
    'raw',
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    { name: 'AES-GCM' } as any,
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function getOrCreateArchiveKey(
  conversationId: string,
  userId: string,
): Promise<CryptoKey | null> {
  const cacheKey = `${userId}:${conversationId}`;
  const cached = ramCache.get(cacheKey);
  if (cached) return cached;

  const masterKey = await getArchiveMasterKey(userId);
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
      const key = await importAesKey(raw);
      raw.fill(0);
      ramCache.set(cacheKey, key);
      return key;
    }
  } catch {
    // An existing row that cannot be unwrapped must not be replaced with a new
    // random key. Another linked device may still hold the correct Master Key.
    return null;
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

    const { data: stored } = await supabase
      .from('conversation_archive_keys' as any)
      .select('wrapped_key')
      .eq('conversation_id', conversationId)
      .eq('user_id', userId)
      .maybeSingle();

    raw.fill(0);
    if (!stored || !(stored as any).wrapped_key) return null;

    const storedRaw = await unwrapKey((stored as any).wrapped_key, masterKey, aad);
    const key = await importAesKey(storedRaw);
    storedRaw.fill(0);
    ramCache.set(cacheKey, key);
    maybeShowActivationToastOnce();
    return key;
  } catch {
    return null;
  }
}

export interface ArchivePayload {
  v: 2;
  iv: string;
  ct: string;
  context: string;
}

export function isArchivePayload(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const payload = JSON.parse(value);
    return payload?.v === 2
      && typeof payload.iv === 'string'
      && typeof payload.ct === 'string'
      && typeof payload.context === 'string';
  } catch {
    return false;
  }
}

export async function encryptArchive(
  plaintext: string,
  conversationId: string,
  userId: string,
  contextId = conversationId,
): Promise<string | null> {
  if (!plaintext || !isArchiveBackupEnabled()) return null;
  const key = await getOrCreateArchiveKey(conversationId, userId);
  if (!key) return null;

  try {
    const iv = hardCrypto.getRandomValues(new Uint8Array(IV_LEN));
    const ct = await hardCrypto.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as Uint8Array<ArrayBuffer>,
        additionalData: new hardGlobals.TextEncoder().encode(
          `FORSURE-AEGIS-ARCHIVE-v2|${userId}|${conversationId}|${contextId}`,
        ),
        tagLength: 128,
      },
      key,
      new hardGlobals.TextEncoder().encode(plaintext),
    );
    return JSON.stringify({
      v: 2,
      iv: bufferToBase64(iv.buffer as ArrayBuffer),
      ct: bufferToBase64(ct as ArrayBuffer),
      context: contextId,
    } satisfies ArchivePayload);
  } catch {
    return null;
  }
}

export async function decryptArchive(
  archiveBody: string,
  conversationId: string,
  userId: string,
  expectedContextId = conversationId,
): Promise<string | null> {
  if (!isArchivePayload(archiveBody)) return null;
  const key = await getOrCreateArchiveKey(conversationId, userId);
  if (!key) return null;

  try {
    const parsed = JSON.parse(archiveBody) as ArchivePayload;
    if (parsed.context !== expectedContextId) return null;
    const iv = new Uint8Array(base64ToBuffer(parsed.iv));
    const ciphertext = base64ToBuffer(parsed.ct);
    const plaintext = await hardCrypto.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as Uint8Array<ArrayBuffer>,
        additionalData: new hardGlobals.TextEncoder().encode(
          `FORSURE-AEGIS-ARCHIVE-v2|${userId}|${conversationId}|${expectedContextId}`,
        ),
        tagLength: 128,
      },
      key,
      ciphertext,
    );
    return new hardGlobals.TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

export async function preloadAllArchiveKeys(userId: string): Promise<number> {
  const masterKey = await getArchiveMasterKey(userId);
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
        const key = await importAesKey(raw);
        raw.fill(0);
        ramCache.set(cacheKey, key);
        loaded += 1;
      } catch {
        // Keep the row untouched: it may require the correct linked-device key.
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

export async function archiveBubbleForUser(input: {
  messageId: string;
  conversationId: string;
  userId: string;
  plaintext: string;
}): Promise<boolean> {
  const archiveBody = await encryptArchive(
    input.plaintext,
    input.conversationId,
    input.userId,
    input.messageId,
  );
  if (!archiveBody) return false;
  const { error } = await supabase
    .from('message_archives' as any)
    .upsert({
      message_id: input.messageId,
      user_id: input.userId,
      archive_body: archiveBody,
    }, {
      onConflict: 'message_id,user_id',
      ignoreDuplicates: true,
    });
  return !error;
}

export async function recoverBubbleFromArchive(input: {
  messageId: string;
  conversationId: string;
  userId: string;
}): Promise<string | null> {
  const { data, error } = await supabase
    .from('message_archives' as any)
    .select('archive_body')
    .eq('message_id', input.messageId)
    .eq('user_id', input.userId)
    .maybeSingle();
  if (error || !(data as any)?.archive_body) return null;
  return decryptArchive(
    (data as any).archive_body,
    input.conversationId,
    input.userId,
    input.messageId,
  );
}
