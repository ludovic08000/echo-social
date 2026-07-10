/**
 * Optional encrypted ratchet-state escrow.
 *
 * Security policy:
 * - Disabled by default. Persisting root/chain keys off-device weakens forward
 *   secrecy even when the server only stores ciphertext.
 * - Historical ratchet archives are never uploaded by this module.
 * - Deployments that explicitly accept the current-session durability tradeoff
 *   may set VITE_ALLOW_E2EE_SESSION_ESCROW=true at build time.
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

function isSessionEscrowEnabled(): boolean {
  return import.meta.env.VITE_ALLOW_E2EE_SESSION_ESCROW === 'true';
}

export type SyncKind = 'session' | 'archive';

interface EncryptedBlob {
  encrypted_blob: string;
  iv: string;
}

interface SyncContext {
  userId: string;
  deviceId: string;
  conversationId: string;
  kind: SyncKind;
}

function currentDeviceId(): string | null {
  try {
    if (isDeviceIdTemporary()) return null;
    return getCurrentDeviceId();
  } catch {
    return null;
  }
}

function buildAAD(context: SyncContext): Uint8Array {
  return new TextEncoder().encode(
    `forsure-ratchet-escrow|${context.userId}|${context.deviceId}|${context.conversationId}|${context.kind}|v2`,
  );
}

function getContext(convId: string, kind: SyncKind): SyncContext | null {
  const userId = getSessionUserId();
  const deviceId = currentDeviceId();
  if (!userId || !deviceId || !convId) return null;
  return { userId, deviceId, conversationId: convId, kind };
}

async function encryptWithSessionKey(plaintext: string, context: SyncContext): Promise<EncryptedBlob | null> {
  const key = getSessionMasterKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const data = new TextEncoder().encode(plaintext);
  const ct = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv, additionalData: buildAAD(context) },
    key,
    data,
  );
  return { encrypted_blob: bufferToBase64(ct), iv: bufferToBase64(iv.buffer as ArrayBuffer) };
}

async function decryptWithSessionKey(blob: EncryptedBlob, context: SyncContext): Promise<string | null> {
  const key = getSessionMasterKey();
  if (!key) return null;
  try {
    const iv = new Uint8Array(base64ToBuffer(blob.iv));
    const ct = base64ToBuffer(blob.encrypted_blob);
    const pt = await hardCrypto.decrypt(
      { name: 'AES-GCM', iv, additionalData: buildAAD(context) },
      key,
      ct,
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

async function upsertBlob(context: SyncContext, blob: EncryptedBlob): Promise<boolean> {
  try {
    const { error } = await (supabase as any)
      .from(TABLE)
      .upsert(
        {
          user_id: context.userId,
          device_id: context.deviceId,
          conversation_id: context.conversationId,
          kind: context.kind,
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

async function fetchBlob(context: SyncContext): Promise<EncryptedBlob | null> {
  try {
    const { data, error } = await (supabase as any)
      .from(TABLE)
      .select('encrypted_blob, iv')
      .eq('user_id', context.userId)
      .eq('device_id', context.deviceId)
      .eq('conversation_id', context.conversationId)
      .eq('kind', context.kind)
      .maybeSingle();
    if (error || !data?.encrypted_blob || !data?.iv) return null;
    return { encrypted_blob: data.encrypted_blob, iv: data.iv };
  } catch {
    return null;
  }
}

export async function pushEncryptedSession(convId: string, state: RatchetState): Promise<boolean> {
  if (!isSessionEscrowEnabled()) return false;
  const context = getContext(convId, 'session');
  if (!context) return false;

  try {
    const serialized = await serializeRatchetState(state);
    const blob = await encryptWithSessionKey(serialized, context);
    if (!blob) return false;
    return upsertBlob(context, blob);
  } catch {
    return false;
  }
}

/** Archives contain old message keys and are intentionally never escrowed. */
export async function pushEncryptedArchive(_convId: string, _archiveJson: string): Promise<boolean> {
  return false;
}

export async function pullEncryptedSession(convId: string): Promise<RatchetState | null> {
  if (!isSessionEscrowEnabled()) return null;
  const context = getContext(convId, 'session');
  if (!context) return null;

  const blob = await fetchBlob(context);
  if (!blob) return null;
  const json = await decryptWithSessionKey(blob, context);
  if (!json) return null;
  try {
    return await deserializeRatchetState(json);
  } catch {
    return null;
  }
}

/** Historical archives are not recoverable from server escrow. */
export async function pullEncryptedArchive(_convId: string): Promise<string | null> {
  return null;
}
