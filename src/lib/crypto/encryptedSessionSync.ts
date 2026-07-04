/**
 * Encrypted session sync to Supabase (durability against local-storage loss).
 *
 * Problem
 * -------
 * On iOS the ratchet state lives in WKWebView IndexedDB, which WebKit evicts
 * after ~7 days of inactivity or under storage pressure. An eviction wipes the
 * session and messages become undecryptable. We want the session to survive a
 * local purge without weakening E2EE.
 *
 * E2EE-preserving design (NON-NEGOTIABLE)
 * ---------------------------------------
 * The ratchet state is encrypted CLIENT-SIDE with the session Master Key
 * (`getSessionMasterKey()` from accountKeyBackup — wrapped by passkey/PIN and
 * NEVER uploaded to the server) using AES-GCM. Supabase only ever stores opaque
 * ciphertext + IV. The server cannot read root/chain/message keys, so it cannot
 * decrypt any message. If the Master Key is not unlocked, sync is a silent
 * no-op (we never fall back to plaintext).
 *
 * Forward-secrecy tradeoff (accepted, WhatsApp-style)
 * ---------------------------------------------------
 * Keeping an encrypted copy of the current session means that a future Master
 * Key compromise could resume it. We mitigate by storing only the CURRENT
 * session (kind='session', overwritten) plus the bounded archive
 * (kind='archive'); we never accumulate a decryptable history of past chains
 * beyond what the local archive already holds.
 */
import { supabase } from '@/integrations/supabase/client';
import { hardCrypto } from './cryptoIntegrity';
import { bufferToBase64, base64ToBuffer, randomBytes } from './utils';
import { getSessionMasterKey, getSessionUserId } from './accountKeyBackup';
import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import {
  serializeRatchetState,
  deserializeRatchetState,
  type RatchetState,
} from './ratchet';

const TABLE = 'e2ee_session_sync';

export type SyncKind = 'session' | 'archive';

interface EncryptedBlob {
  encrypted_blob: string;
  iv: string;
}

/** Encrypt a UTF-8 string with the session Master Key. Null if locked. */
async function encryptWithSessionKey(plaintext: string): Promise<EncryptedBlob | null> {
  const key = getSessionMasterKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const data = new TextEncoder().encode(plaintext);
  const ct = await hardCrypto.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { encrypted_blob: bufferToBase64(ct), iv: bufferToBase64(iv.buffer) };
}

/** Decrypt a blob produced by encryptWithSessionKey. Null if locked/invalid. */
async function decryptWithSessionKey(blob: EncryptedBlob): Promise<string | null> {
  const key = getSessionMasterKey();
  if (!key) return null;
  try {
    const iv = new Uint8Array(base64ToBuffer(blob.iv));
    const ct = base64ToBuffer(blob.encrypted_blob);
    const pt = await hardCrypto.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

function currentDeviceId(): string | null {
  try {
    if (isDeviceIdTemporary()) return null;
    return getCurrentDeviceId();
  } catch {
    return null;
  }
}

async function upsertBlob(convId: string, kind: SyncKind, blob: EncryptedBlob): Promise<boolean> {
  const userId = getSessionUserId();
  const deviceId = currentDeviceId();
  if (!userId || !deviceId) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from(TABLE)
      .upsert(
        {
          user_id: userId,
          device_id: deviceId,
          conversation_id: convId,
          kind,
          encrypted_blob: blob.encrypted_blob,
          iv: blob.iv,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,device_id,conversation_id,kind' },
      );
    return !error;
  } catch {
    return false;
  }
}

async function fetchBlob(convId: string, kind: SyncKind): Promise<EncryptedBlob | null> {
  const userId = getSessionUserId();
  const deviceId = currentDeviceId();
  if (!userId || !deviceId) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from(TABLE)
      .select('encrypted_blob, iv')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .eq('conversation_id', convId)
      .eq('kind', kind)
      .maybeSingle();
    if (error || !data?.encrypted_blob || !data?.iv) return null;
    return { encrypted_blob: data.encrypted_blob, iv: data.iv };
  } catch {
    return null;
  }
}

/**
 * Push the current ratchet state (encrypted) to Supabase. Best-effort; returns
 * false without side effects if the Master Key is locked or the write fails.
 */
export async function pushEncryptedSession(convId: string, state: RatchetState): Promise<boolean> {
  try {
    const serialized = await serializeRatchetState(state);
    const blob = await encryptWithSessionKey(serialized);
    if (!blob) return false;
    return await upsertBlob(convId, 'session', blob);
  } catch {
    return false;
  }
}

/** Push an opaque (already-serialized) archive payload, encrypted. */
export async function pushEncryptedArchive(convId: string, archiveJson: string): Promise<boolean> {
  try {
    const blob = await encryptWithSessionKey(archiveJson);
    if (!blob) return false;
    return await upsertBlob(convId, 'archive', blob);
  } catch {
    return false;
  }
}

/**
 * Pull + decrypt the current ratchet state from Supabase. Returns null if
 * absent, locked, or corrupt. Used to restore after a local IndexedDB purge.
 */
export async function pullEncryptedSession(convId: string): Promise<RatchetState | null> {
  const blob = await fetchBlob(convId, 'session');
  if (!blob) return null;
  const json = await decryptWithSessionKey(blob);
  if (!json) return null;
  try {
    return await deserializeRatchetState(json);
  } catch {
    return null;
  }
}

/** Pull + decrypt the archive payload (raw JSON string) from Supabase. */
export async function pullEncryptedArchive(convId: string): Promise<string | null> {
  const blob = await fetchBlob(convId, 'archive');
  if (!blob) return null;
  return decryptWithSessionKey(blob);
}
