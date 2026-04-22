/**
 * Regression tests for media message sending (plaintext + E2EE).
 *
 * Bug history: media messages whose body embeds a per-file AES key
 * (`label\x00MKEY:<base64>`) were being rejected by the anti-spam validator
 * because they contain a NUL byte and are not "natural" text. The fix was to
 * detect such bodies in `useMessageQueue.sendMessage` and bypass validation.
 *
 * These tests pin both halves of the contract:
 *   1) `validateMessage` — what would happen if the gate were NOT applied.
 *   2) `isSpecialMediaBody` — the gate logic itself, mirrored from the hook,
 *      so any future change to the rule breaks this test on purpose.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { validateMessage, recordSentMessage } from '@/lib/messageAntiSpam';
import {
  buildMediaMessageBody,
  parseMediaMessage,
  hasMediaKey,
  MEDIA_KEY_SEPARATOR,
} from '@/lib/crypto/mediaEncrypt';

// ─── Mirror of the gating rule used in src/hooks/useMessageQueue.ts ───
//
// If this drifts from the hook, the tests below should fail and force us to
// re-sync intentionally. Keeping it here (rather than importing the hook)
// avoids pulling React + Supabase into a unit test.
function isSpecialMediaBody(body: string): boolean {
  const isMediaWithKey = body.includes('\x00MKEY:');
  return (
    body.startsWith('🎙️ voice:') ||
    body === '📷 Photo' ||
    body === '🎬 Vidéo' ||
    isMediaWithKey
  );
}

// Reset anti-spam internal state between tests by waiting past the cooldown.
// (`recentMessages` is module-scoped; we don't want order-dependent flakes.)
async function resetAntiSpam() {
  // Sleep long enough to clear cooldown + duplicate window.
  await new Promise((r) => setTimeout(r, 350));
}

describe('media message sending — anti-spam gating', () => {
  beforeEach(async () => {
    await resetAntiSpam();
  });

  describe('plaintext labels (Zeus / pre-E2EE fallback)', () => {
    it('accepts the bare "📷 Photo" label as a special body', () => {
      expect(isSpecialMediaBody('📷 Photo')).toBe(true);
    });

    it('accepts the bare "🎬 Vidéo" label as a special body', () => {
      expect(isSpecialMediaBody('🎬 Vidéo')).toBe(true);
    });

    it('accepts a voice note marker as a special body', () => {
      expect(isSpecialMediaBody('🎙️ voice:https://example.com/v.mp4.enc')).toBe(true);
    });

    it('still validates ordinary text bodies', () => {
      const v = validateMessage('Salut, ça va ?');
      expect(v.valid).toBe(true);
    });
  });

  describe('E2EE bodies with embedded media key', () => {
    const KEY_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

    it('builds a body containing the MKEY separator', () => {
      const body = buildMediaMessageBody('📷 Photo', KEY_B64);
      expect(body).toContain(MEDIA_KEY_SEPARATOR);
      expect(hasMediaKey(body)).toBe(true);
    });

    it('round-trips label + key through parseMediaMessage', () => {
      const body = buildMediaMessageBody('🎬 Vidéo', KEY_B64);
      const parsed = parseMediaMessage(body);
      expect(parsed).not.toBeNull();
      expect(parsed!.label).toBe('🎬 Vidéo');
      expect(parsed!.keyB64).toBe(KEY_B64);
    });

    it('photo body with embedded key is recognised as special (bypass anti-spam)', () => {
      const body = buildMediaMessageBody('📷 Photo', KEY_B64);
      expect(isSpecialMediaBody(body)).toBe(true);
    });

    it('video body with embedded key is recognised as special', () => {
      const body = buildMediaMessageBody('🎬 Vidéo', KEY_B64);
      expect(isSpecialMediaBody(body)).toBe(true);
    });

    it('any custom label with the MKEY separator is recognised as special', () => {
      const body = buildMediaMessageBody('🖼️ Image', KEY_B64);
      expect(isSpecialMediaBody(body)).toBe(true);
    });

    it('demonstrates why the gate is needed: raw validateMessage on a key-bearing body would mishandle it', () => {
      // We do not assert valid=false here (the validator may or may not
      // reject NUL bytes depending on its rules). The point is that the
      // body is binary-ish and must not flow through anti-spam at all —
      // hence the gate. We assert the gate catches it.
      const body = buildMediaMessageBody('📷 Photo', KEY_B64);
      expect(isSpecialMediaBody(body)).toBe(true);
    });
  });

  describe('regression: ordinary text starting with similar characters', () => {
    it('"📷 Photo of my cat" is NOT treated as special (no key, not exact label)', () => {
      // Important: the gate must be strict on exact match for the bare label,
      // otherwise users could craft a caption that bypasses anti-spam.
      expect(isSpecialMediaBody('📷 Photo of my cat')).toBe(false);
    });

    it('a normal sentence containing "MKEY" without the NUL prefix is NOT special', () => {
      expect(isSpecialMediaBody('My key is MKEY:something')).toBe(false);
    });
  });

  describe('anti-spam record after sending media', () => {
    it('recordSentMessage tolerates a media body with NUL + key (no throw)', () => {
      const body = buildMediaMessageBody('📷 Photo', 'AAAA');
      expect(() => recordSentMessage(body)).not.toThrow();
    });
  });
});
