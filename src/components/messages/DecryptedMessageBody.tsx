import { useState, useEffect, useRef, memo } from 'react';
import { VoiceMessagePlayer } from '@/components/chat/VoiceRecorder';
import { setMediaKey } from './mediaKeyCache';
import {
  resolvePlaintext,
  readCache,
  dropCache,
  clearNegativeCache,
  persistOutcome,
  looksEncrypted,
  buildOutcomeFromText,
  type DecryptionOutcome,
} from './decryptionService';
import { isImageMediaLabel, isVideoMediaLabel } from '@/lib/crypto/mediaEncrypt';
import type { DecryptResult } from '@/hooks/useE2EE';

/**
 * DecryptedMessageBody — passive presentational component.
 *
 * It owns NO crypto logic. It delegates every resolution step to
 * `decryptionService.resolvePlaintext` and only decides:
 *   - Which media renderer to pick (voice / GIF / text).
 *   - Whether to show the neutral placeholder while waiting.
 *
 * On failure the component renders an invisible spacer — no string,
 * no lock icon — and waits for `forsure-decrypt-retry` to re-attempt.
 */

function parseVoiceMessage(text: string): { url: string; duration: number } | null {
  const m1 = text.match(/^🎙️\s*(?:vocal|voice):(.+)\|(\d+)$/);
  if (m1) return { url: m1[1], duration: parseInt(m1[2], 10) };
  const m2 = text.match(/^🎙️\s*(?:vocal|voice):(.+)\|dur:(\d+)$/);
  if (m2) return { url: m2[1], duration: parseInt(m2[2], 10) };
  return null;
}

function parseGifMessage(text: string): string | null {
  const match = text.match(/^GIF:(https?:\/\/.+)$/i);
  return match ? match[1] : null;
}

interface DecryptedMessageBodyProps {
  body: string;
  decrypt: (body: string) => Promise<DecryptResult>;
  isEncryptionActive: boolean;
  onDecrypted?: (text: string) => void;
  isMe?: boolean;
  cachedPlaintext?: string;
  refreshKey?: string | number;
  messageId?: string;
  hasMedia?: boolean;
}

export const DecryptedMessageBody = memo(function DecryptedMessageBody({
  body,
  decrypt,
  isEncryptionActive: _isEncryptionActive,
  onDecrypted,
  isMe,
  cachedPlaintext,
  refreshKey,
  messageId,
  hasMedia,
}: DecryptedMessageBodyProps) {
  // Synchronous initial state — uses RAM cache + cleartext shortcut so the
  // first paint never flashes a placeholder when plaintext is already known.
  const initial: { outcome: DecryptionOutcome | null; pending: boolean } = (() => {
    if (cachedPlaintext) {
      const outcome = buildOutcomeFromText(cachedPlaintext);
      return { outcome, pending: false };
    }
    if (!looksEncrypted(body)) {
      return { outcome: { text: body, mediaKeyB64: null, hidden: false }, pending: false };
    }
    const cached = readCache(messageId, body);
    if (cached) return { outcome: cached, pending: false };
    return { outcome: null, pending: true };
  })();

  const [outcome, setOutcome] = useState<DecryptionOutcome | null>(initial.outcome);
  const [pending, setPending] = useState(initial.pending);
  const [retryTick, setRetryTick] = useState(0);

  const onDecryptedRef = useRef(onDecrypted);
  onDecryptedRef.current = onDecrypted;

  // Listen for the global retry event fired after key restoration / queue
  // success. Drop any stale RAM entry so the effect below re-resolves.
  useEffect(() => {
    const handler = () => {
      // A successful queue retry/key restore wipes the negative cache so
      // every silent bubble re-attempts on the next render pass.
      clearNegativeCache();
      dropCache(messageId, body);
      setRetryTick((t) => t + 1);
    };
    window.addEventListener('forsure-decrypt-retry', handler);
    return () => window.removeEventListener('forsure-decrypt-retry', handler);
  }, [messageId, body]);

  useEffect(() => {
    let cancelled = false;

    // cachedPlaintext provided by parent always wins (post-send echo).
    if (cachedPlaintext) {
      const next = buildOutcomeFromText(cachedPlaintext);
      setOutcome(next);
      setPending(false);
      if (next.mediaKeyB64 && messageId) {
        setMediaKey(messageId, next.mediaKeyB64, isVideoMediaLabel(next.text));
      }
      // NOTE: do NOT re-notify parent — it already owns this plaintext.
      // Calling onDecrypted here would trigger a parent state bump, change
      // `refreshKey`, re-run this effect, and create an infinite loop.
      return;
    }

    if (!looksEncrypted(body)) {
      setOutcome({ text: body, mediaKeyB64: null, hidden: false });
      setPending(false);
      return;
    }

    setPending(true);
    void resolvePlaintext({ body, messageId, isMe, decrypt })
      .then((next) => {
        if (cancelled) return;
        if (!next) {
          // Silent pending — UI shows neutral placeholder, queue will retry.
          setOutcome(null);
          setPending(true);
          return;
        }
        setOutcome(next);
        setPending(false);
        if (next.mediaKeyB64 && messageId) {
          setMediaKey(messageId, next.mediaKeyB64, isVideoMediaLabel(next.text));
        }
        if (!next.hidden) {
          const persisted = persistOutcome(body, next, messageId);
          onDecryptedRef.current?.(persisted);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOutcome(null);
          setPending(true);
        }
      });

    return () => { cancelled = true; };
    // retryTick + refreshKey force a re-attempt after key restoration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, messageId, cachedPlaintext, retryTick, refreshKey]);

  if (outcome?.hidden) return null;

  if (pending || outcome === null) {
    // Neutral, invisible placeholder — never reveals state to the user.
    return <span className="opacity-0 select-none" aria-hidden="true">·</span>;
  }

  const { text, mediaKeyB64 } = outcome;

  if (hasMedia && (isImageMediaLabel(text) || isVideoMediaLabel(text))) return null;

  const voice = parseVoiceMessage(text);
  if (voice) {
    return (
      <VoiceMessagePlayer
        audioUrl={voice.url}
        duration={voice.duration}
        isMe={isMe}
        mediaKeyB64={mediaKeyB64 ?? undefined}
      />
    );
  }

  const gifUrl = parseGifMessage(text);
  if (gifUrl) {
    return (
      <img
        src={gifUrl}
        alt="GIF"
        className="rounded-lg max-w-[220px] max-h-[200px] object-contain"
        loading="lazy"
      />
    );
  }

  return <>{text}</>;
});
