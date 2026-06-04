/**
 * Legacy decrypt router — central dispatch for every wire format we have
 * ever shipped. Sesame rule: a message that was once readable must stay
 * readable forever. We never delete a decoder.
 *
 * Supported runtime formats (most recent first):
 *   - `x3dh5.` Double Ratchet w/ DH + AAD              (deviceRatchet v5)
 *   - `x3dh5.init.` authenticated X3DH bootstrap       (multiDeviceFanout)
 *   - `x3dh4.` Double Ratchet w/ DH ratchet            (deviceRatchet v4)
 *   - JSON `{v, kem, iv, ct, sig, hdr...}` conv-level  (ratchet/e2ee)
 *
 * For conversation-level (per-conv ratchet) envelopes we just delegate to
 * `ratchetDecrypt`/`decryptMessage` from the existing crypto module — we
 * don't reimplement them here.
 */
import {
  RATCHET_PREFIX_V4,
  RATCHET_PREFIX_V5,
  ratchetDecrypt as deviceRatchetDecrypt,
} from '@/lib/crypto/deviceRatchet';
import { tryReadDeviceCopy } from '@/lib/messaging/multiDeviceFanout';
import type { DecryptResult } from './types';
import { selfDeviceId } from './deviceRegistry';
import { supabase } from '@/integrations/supabase/client';

/**
 * Extinction plan for the legacy router.
 *
 * The router is now pinned to v5, with v4 kept as a temporary compatibility
 * reader. Each successful decode bumps a per-format counter so we can
 * see — empirically — when the legacy formats stop being used.
 *
 * After `LEGACY_ROUTER_EXTINCTION_DATE` we will:
 *   1. Keep rejecting NEW writes in any pre-v5 format (already true today
 *      for outbound traffic — only `ratchetEncrypt` is used).
 *   2. If 30 consecutive days of zero hits on `legacy-router`, remove the
 *      remaining compatibility decoder.
 *
 * Until then, every legacy hit is logged silently for the SOC dashboard.
 */
export const LEGACY_ROUTER_EXTINCTION_DATE = '2026-06-04';

type LegacyHitKey = 'ratchet-v5' | 'ratchet-v4' | 'legacy-router';
const HITS: Record<LegacyHitKey, { count: number; last: string | null }> = {
  'ratchet-v5': { count: 0, last: null },
  'ratchet-v4': { count: 0, last: null },
  'legacy-router': { count: 0, last: null },
};

function recordHit(via: LegacyHitKey) {
  const entry = HITS[via];
  entry.count += 1;
  entry.last = new Date().toISOString();
  // Cheap localStorage mirror so the dashboard / Zeus admin can read it.
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('e2ee.legacyRouter.hits', JSON.stringify(HITS));
    }
  } catch { /* private mode — ignore */ }
}

/** Diagnostics: snapshot of decoder hit counts since page load. */
export function legacyRouterStats(): Readonly<typeof HITS> {
  return HITS;
}

/** True if today is past the extinction date. */
export function isLegacyRouterExtinct(now: Date = new Date()): boolean {
  return now.toISOString().slice(0, 10) >= LEGACY_ROUTER_EXTINCTION_DATE;
}

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

  // v3 / v4 / v5 device-pair ratchet — fastest, handles recent traffic.
  if (encryptedBody.startsWith(RATCHET_PREFIX_V5)) {
    try {
      const pt = await deviceRatchetDecrypt(args.recipientUserId, me, encryptedBody);
      if (pt !== null) {
        recordHit('ratchet-v5');
        return { ok: true, plaintext: pt, via: 'ratchet-v5' };
      }
    } catch { /* fall through */ }
  }
  if (encryptedBody.startsWith(RATCHET_PREFIX_V4)) {
    try {
      const pt = await deviceRatchetDecrypt(args.recipientUserId, me, encryptedBody);
      if (pt !== null) {
        recordHit('ratchet-v4');
        return { ok: true, plaintext: pt, via: 'ratchet-v4' };
      }
    } catch { /* fall through */ }
  }
  // X3DH v5 bootstrap copies are handled by the existing `tryReadDeviceCopy`
  // pipeline, which keeps one implementation for device-copy recovery.
  if (args.messageId) {
    try {
      const pt = await tryReadDeviceCopy(args.messageId, args.senderUserId);
      if (pt !== null) {
        recordHit('legacy-router');
        return { ok: true, plaintext: pt, via: 'legacy-router' };
      }
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
    if (pt !== null) {
      recordHit('legacy-router');
      return { ok: true, plaintext: pt, via: 'legacy-router' };
    }
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
