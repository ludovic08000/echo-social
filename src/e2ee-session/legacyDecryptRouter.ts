/**
 * Legacy decrypt router — central dispatch for every wire format we have
 * ever shipped. Sesame rule: a message that was once readable must stay
 * readable forever. We never delete a decoder.
 *
 * Supported formats (most recent first):
 *   - `x3dh4.` Double Ratchet w/ DH ratchet            (deviceRatchet v4)
 *   - `x3dh3.` legacy single-secret KDF chain          (deviceRatchet v3)
 *   - `x3dh2.` X3DH bootstrap with one-time prekey     (multiDeviceFanout)
 *   - `x3dh1.` X3DH bootstrap, no OTPK                 (multiDeviceFanout)
 *   - `<iv>.<ct>` raw device-wrap ECDH                 (deviceWrap legacy)
 *   - JSON `{v, kem, iv, ct, sig, hdr...}` conv-level  (ratchet/e2ee)
 *
 * For conversation-level (per-conv ratchet) envelopes we just delegate to
 * `ratchetDecrypt`/`decryptMessage` from the existing crypto module — we
 * don't reimplement them here.
 */
import {
  RATCHET_PREFIX_V3,
  RATCHET_PREFIX_V4,
  RATCHET_PREFIX_V5,
  ratchetDecrypt as deviceRatchetDecrypt,
} from '@/lib/crypto/deviceRatchet';
import { tryReadDeviceCopy } from '@/lib/messaging/multiDeviceFanout';
import type { DecryptResult } from './types';
import { selfDeviceId } from './deviceRegistry';
import { supabase } from '@/integrations/supabase/client';

/**
 * Try to decrypt a single device-copy `encrypted_body`. Wraps every legacy
 * format. Returns `{ ok, plaintext, via }`. Never throws.
 */
export async function legacyDecryptDeviceCopy(args: {
  encryptedBody: string;
  recipientUserId: string;
  senderUserId?: string;
  /** Filled when the caller already knows the original message id. */
  messageId?: string;
}): Promise<DecryptResult> {
  const { encryptedBody } = args;
  const me = selfDeviceId();

  // v3 / v4 device-pair ratchet — fastest, handles 99% of recent traffic.
  if (encryptedBody.startsWith(RATCHET_PREFIX_V5)) {
    try {
      const pt = await deviceRatchetDecrypt(args.recipientUserId, me, encryptedBody);
      if (pt !== null) return { ok: true, plaintext: pt, via: 'ratchet-v5' };
    } catch { /* fall through */ }
  }
  if (encryptedBody.startsWith(RATCHET_PREFIX_V4)) {
    try {
      const pt = await deviceRatchetDecrypt(args.recipientUserId, me, encryptedBody);
      if (pt !== null) return { ok: true, plaintext: pt, via: 'ratchet-v4' };
    } catch { /* fall through */ }
  }
  if (encryptedBody.startsWith(RATCHET_PREFIX_V3)) {
    try {
      const pt = await deviceRatchetDecrypt(args.recipientUserId, me, encryptedBody);
      if (pt !== null) return { ok: true, plaintext: pt, via: 'ratchet-v3' };
    } catch { /* fall through */ }
  }

  // X3DH-bootstrap and deviceWrap fallbacks are handled by the existing
  // `tryReadDeviceCopy` pipeline (which loops over every device-copy row
  // and tries every (priv, peerPub) candidate). We delegate so we keep ONE
  // implementation for those legacy paths.
  if (args.messageId) {
    try {
      const pt = await tryReadDeviceCopy(args.messageId, args.senderUserId);
      if (pt !== null) return { ok: true, plaintext: pt, via: 'legacy-router' };
    } catch { /* fall through */ }
  }

  return { ok: false, plaintext: null, errorCode: 'NO_LEGACY_PATH_MATCHED' };
}

/**
 * Try every device-copy row of `messageId` (covers the case where the local
 * `device_id` rotated — see iOS Keychain wipe scenario).
 */
export async function legacyDecryptByMessageId(messageId: string, expectedSenderUserId?: string): Promise<DecryptResult> {
  try {
    const pt = await tryReadDeviceCopy(messageId, expectedSenderUserId);
    if (pt !== null) return { ok: true, plaintext: pt, via: 'legacy-router' };
  } catch { /* fall through */ }
  return { ok: false, plaintext: null, errorCode: 'NO_DEVICE_COPY_DECRYPTED' };
}

/**
 * Helper exposed for diagnostics — returns whether a body shape *looks*
 * like a known crypto envelope. Never inspects content beyond the prefix.
 */
export function isKnownLegacyFormat(encryptedBody: string): boolean {
  return (
    encryptedBody.startsWith(RATCHET_PREFIX_V5) ||
    encryptedBody.startsWith(RATCHET_PREFIX_V4) ||
    encryptedBody.startsWith(RATCHET_PREFIX_V3) ||
    encryptedBody.startsWith('x3dh1.') ||
    encryptedBody.startsWith('x3dh2.') ||
    /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(encryptedBody) ||  // device-wrap iv.ct
    encryptedBody.startsWith('{')                                  // JSON envelope
  );
}

/** Hook for diagnostics: lookup a message body without throwing. */
export async function fetchMessageBody(messageId: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('messages')
      .select('body')
      .eq('id', messageId)
      .maybeSingle();
    return (data as { body?: string } | null)?.body ?? null;
  } catch {
    return null;
  }
}
