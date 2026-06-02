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

const KDF_VERSION = 1;
const IV_LEN = 12;
const KEY_LEN = 32; // AES-256

/** In-RAM cache of decrypted (CryptoKey) archive keys. Purged on session clear. */
const ramCache = new Map<string, CryptoKey>();

export function clearArchiveKeyCache(): void {
  ramCache.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('forsure:e2ee-purge', clearArchiveKeyCache);
  window.addEventListener('forsure:e2ee-restore-needed', clearArchiveKeyCache);

  // Pre-warm all archive keys as soon as the session master key is unlocked.
  // This guarantees that the user's full message history is decryptable
  // synchronously, even after device rotation or cache purge.
  const preloadOnUnlock = (ev: Event) => {
    const detail = (ev as CustomEvent).detail || {};
    const uid = (detail as any).userId as string | undefined;
    if (!uid) return;
    // Fire-and-forget; safe to run multiple times (idempotent on cache).
    void preloadAllArchiveKeys(uid).catch(() => {});
  };
  window.addEventListener('forsure:e2ee-unlocked', preloadOnUnlock);
  window.addEventListener('forsure:e2ee-post-restore', preloadOnUnlock);
}

interface ArchiveKeyRow {
  conversation_id: string;
  wrapped_key: string; // base64( IV(12) || ciphertext )
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

/**
 * Returns the AES-GCM CryptoKey for this conversation+user, creating and
 * uploading it on first use. Returns `null` when the master key is not
 * unlocked — caller must skip archiving silently.
 */
export async function getOrCreateArchiveKey(conversationId: string, userId: string): Promise<CryptoKey | null> {
  const cacheKey = `${userId}:${conversationId}`;
  const cached = ramCache.get(cacheKey);
  if (cached) return cached;

  const masterKey = getSessionMasterKey();
  if (!masterKey) return null;

  const aad = aadFor(userId, conversationId);

  // 1) Try fetch existing row
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

  // 2) Create + publish
  try {
    const raw = hardCrypto.getRandomValues(new Uint8Array(KEY_LEN));
    const wrapped = await wrapKey(raw, masterKey, aad);

    const { error } = await supabase
      .from('conversation_archive_keys' as any)
      .insert({
        conversation_id: conversationId,
        user_id: userId,
        wrapped_key: wrapped,
        kdf_version: KDF_VERSION,
      });

    // Tolerate unique-constraint races: re-read.
    if (error) {
      const { data: existing } = await supabase
        .from('conversation_archive_keys' as any)
        .select('wrapped_key')
        .eq('conversation_id', conversationId)
        .eq('user_id', userId)
        .maybeSingle();
      if (existing && (existing as any).wrapped_key) {
        const r = await unwrapKey((existing as any).wrapped_key, masterKey, aad);
        const ck = await importAesKey(r);
        r.fill(0);
        ramCache.set(cacheKey, ck);
        return ck;
      }
      raw.fill(0);
      return null;
    }

    const ck = await importAesKey(raw);
    raw.fill(0);
    ramCache.set(cacheKey, ck);
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

/**
 * Encrypts plaintext to an archive payload (JSON string) suitable for
 * messages.archive_body. Returns null if the archive layer isn't available
 * (no master key / no convergent key) — caller proceeds without archive.
 */
export async function encryptArchive(plaintext: string, conversationId: string, userId: string): Promise<string | null> {
  if (!plaintext) return null;
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

/**
 * Decrypts an archive payload. Returns null when the key cannot be derived
 * or the payload is malformed — caller must keep waiting for other paths.
 */
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

/**
 * Pre-warm all archive keys for the authenticated user. Call once after
 * unlock so subsequent decrypt calls are synchronous-ish.
 */
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
        /* skip — corrupted wrap, will be re-issued on next send */
      }
    }
    return loaded;
  } catch {
    return 0;
  }
}
