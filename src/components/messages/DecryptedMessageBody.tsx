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

const SILENT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000];
const RECOVERY_UNAVAILABLE_AFTER_MS = 15_000;

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
  const [recoveryExpired, setRecoveryExpired] = useState(false);

  const onDecryptedRef = useRef(onDecrypted);
  onDecryptedRef.current = onDecrypted;
  const silentRetryAttemptRef = useRef(0);

  useEffect(() => {
    if (!pending || outcome !== null || !looksEncrypted(body)) {
      setRecoveryExpired(false);
      return;
    }
    const timer = window.setTimeout(() => setRecoveryExpired(true), RECOVERY_UNAVAILABLE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [body, outcome, pending, retryTick]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ messageId?: string }>).detail;
      if (detail?.messageId && messageId && detail.messageId !== messageId) return;
      clearNegativeCache(messageId, body);
      dropCache(messageId, body);
      setRecoveryExpired(false);
      setRetryTick((t) => t + 1);
    };
    window.addEventListener('forsure-decrypt-retry', handler);
    return () => window.removeEventListener('forsure-decrypt-retry', handler);
  }, [messageId, body]);

  useEffect(() => {
    if (!looksEncrypted(body) || !pending || outcome !== null) {
      silentRetryAttemptRef.current = 0;
      return;
    }

    const attempt = silentRetryAttemptRef.current;
    if (attempt >= SILENT_RETRY_DELAYS_MS.length) return;

    const timer = window.setTimeout(() => {
      silentRetryAttemptRef.current = attempt + 1;
      clearNegativeCache(messageId, body);
      dropCache(messageId, body);
      setRetryTick((t) => t + 1);
    }, SILENT_RETRY_DELAYS_MS[attempt]);

    return () => window.clearTimeout(timer);
  }, [body, messageId, outcome, pending, retryTick]);

  useEffect(() => {
    let cancelled = false;

    if (cachedPlaintext) {
      const next = buildOutcomeFromText(cachedPlaintext);
      setOutcome(next);
      setPending(false);
      setRecoveryExpired(false);
      if (next.mediaKeyB64 && messageId) {
        setMediaKey(messageId, next.mediaKeyB64, isVideoMediaLabel(next.text));
      }
      return;
    }

    if (!looksEncrypted(body)) {
      setOutcome({ text: body, mediaKeyB64: null, hidden: false });
      setPending(false);
      setRecoveryExpired(false);
      return;
    }

    setPending(true);
    void resolvePlaintext({ body, messageId, isMe, decrypt })
      .then((next) => {
        if (cancelled) return;
        if (!next) {
          setOutcome(null);
          setPending(true);
          return;
        }
        setOutcome(next);
        setPending(false);
        setRecoveryExpired(false);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, messageId, cachedPlaintext, retryTick, refreshKey]);

  const retryNow = () => {
    clearNegativeCache(messageId, body);
    dropCache(messageId, body);
    setRecoveryExpired(false);
    silentRetryAttemptRef.current = 0;
    setRetryTick((t) => t + 1);
  };

  if (outcome?.hidden) return null;

  if (pending || outcome === null) {
    if (recoveryExpired) {
      return (
        <span className="inline-flex max-w-[260px] flex-col items-start gap-1 text-xs text-muted-foreground" role="status">
          <span>Message chiffré indisponible sur cet appareil.</span>
          <button
            type="button"
            onClick={retryNow}
            className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Réessayer
          </button>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" role="status" aria-live="polite">
        Message en cours de récupération…
      </span>
    );
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
