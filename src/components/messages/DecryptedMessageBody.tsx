import { useState, useEffect, useRef, memo } from 'react';
import { VoiceMessagePlayer } from '@/components/chat/VoiceRecorder';
import { setMediaKey } from './mediaKeyCache';
import {
  resolvePlaintext,
  readCache,
  readLastGoodOutcome,
  clearNegativeCache,
  persistOutcome,
  looksEncrypted,
  buildOutcomeFromText,
  type DecryptionOutcome,
} from './decryptionService';
import { isImageMediaLabel, isVideoMediaLabel } from '@/lib/crypto/mediaEncrypt';
import type { DecryptResult } from '@/hooks/useE2EE';
import { scheduleBubbleRecovery } from '@/lib/messaging/bubbleRecoveryScheduler';

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
  senderId?: string | null;
  hasMedia?: boolean;
}

const SILENT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000];
const RECOVERY_UNAVAILABLE_AFTER_MS = 15_000;

function initialOutcomeFor(
  body: string,
  messageId?: string,
  cachedPlaintext?: string,
): { outcome: DecryptionOutcome | null; pending: boolean } {
  if (cachedPlaintext) {
    return { outcome: buildOutcomeFromText(cachedPlaintext), pending: false };
  }
  if (!looksEncrypted(body)) {
    return { outcome: { text: body, mediaKeyB64: null, hidden: false }, pending: false };
  }
  const cached = readCache(messageId, body) ?? readLastGoodOutcome(messageId, body);
  if (cached) return { outcome: cached, pending: false };
  return { outcome: null, pending: true };
}

export const DecryptedMessageBody = memo(function DecryptedMessageBody({
  body,
  decrypt,
  onDecrypted,
  isMe,
  cachedPlaintext,
  refreshKey,
  messageId,
  senderId,
  hasMedia,
}: DecryptedMessageBodyProps) {
  const initial = initialOutcomeFor(body, messageId, cachedPlaintext);
  const [outcome, setOutcome] = useState<DecryptionOutcome | null>(initial.outcome);
  const [pending, setPending] = useState(initial.pending);
  const [retryTick, setRetryTick] = useState(0);
  const [recoveryExpired, setRecoveryExpired] = useState(false);
  const onDecryptedRef = useRef(onDecrypted);
  onDecryptedRef.current = onDecrypted;
  const silentRetryAttemptRef = useRef(0);
  const identityRef = useRef(messageId ?? body);
  // Publishing plaintext updates the parent cache, which changes refreshKey.
  // Remember the last value we published so that refresh does not feed back
  // into another identical publication and an unbounded render/decrypt loop.
  const lastPublishedPlaintextRef = useRef<string | null>(cachedPlaintext ?? null);
  const lastGoodOutcomeRef = useRef<DecryptionOutcome | null>(
    initial.outcome && !initial.outcome.hidden ? initial.outcome : null,
  );

  const keepOrWait = () => {
    const sticky = lastGoodOutcomeRef.current ?? readLastGoodOutcome(messageId, body) ?? null;
    if (sticky) {
      lastGoodOutcomeRef.current = sticky;
      setOutcome(sticky);
      setPending(false);
      setRecoveryExpired(false);
      return;
    }
    setOutcome(null);
    setPending(true);
  };

  useEffect(() => {
    const identity = messageId ?? body;
    if (identityRef.current === identity) return;
    identityRef.current = identity;

    const next = initialOutcomeFor(body, messageId, cachedPlaintext);
    lastGoodOutcomeRef.current = next.outcome && !next.outcome.hidden ? next.outcome : null;
    setOutcome(next.outcome);
    setPending(next.pending);
    setRecoveryExpired(false);
    silentRetryAttemptRef.current = 0;
    lastPublishedPlaintextRef.current = cachedPlaintext ?? null;
  }, [body, cachedPlaintext, messageId]);

  useEffect(() => {
    if (!pending || outcome !== null || !looksEncrypted(body)) {
      setRecoveryExpired(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setRecoveryExpired(true);
    }, RECOVERY_UNAVAILABLE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [body, outcome, pending, retryTick]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ messageId?: string }>).detail;
      if (detail?.messageId && messageId && detail.messageId !== messageId) return;

      clearNegativeCache(messageId, body);
      setRecoveryExpired(false);
      setRetryTick((tick) => tick + 1);
    };
    window.addEventListener('forsure-decrypt-retry', handler);
    return () => window.removeEventListener('forsure-decrypt-retry', handler);
  }, [messageId, body, pending]);

  useEffect(() => {
    if (!looksEncrypted(body) || !pending || outcome !== null) {
      silentRetryAttemptRef.current = 0;
      return;
    }

    const attempt = silentRetryAttemptRef.current;
    if (attempt >= SILENT_RETRY_DELAYS_MS.length) return;

    const recoveryKey = `${messageId ?? 'noid'}|${body}`;
    return scheduleBubbleRecovery(
      recoveryKey,
      SILENT_RETRY_DELAYS_MS[attempt],
      () => {
        silentRetryAttemptRef.current = attempt + 1;
        clearNegativeCache(messageId, body);
        setRetryTick((tick) => tick + 1);
      },
    );
  }, [body, messageId, outcome, pending, retryTick]);

  useEffect(() => {
    let cancelled = false;

    const commit = (next: DecryptionOutcome) => {
      if (cancelled) return;
      if (!next.hidden && next.text !== '') lastGoodOutcomeRef.current = next;
      setOutcome(next);
      setPending(false);
      setRecoveryExpired(false);
      if (next.mediaKeyB64 && messageId) {
        setMediaKey(messageId, next.mediaKeyB64, isVideoMediaLabel(next.text));
      }
      if (!next.hidden) {
        const persisted = persistOutcome(body, next, messageId);
        if (lastPublishedPlaintextRef.current !== persisted) {
          lastPublishedPlaintextRef.current = persisted;
          onDecryptedRef.current?.(persisted);
        }
      }
    };

    if (cachedPlaintext) {
      commit(buildOutcomeFromText(cachedPlaintext));
      return () => { cancelled = true; };
    }

    if (!looksEncrypted(body)) {
      commit({ text: body, mediaKeyB64: null, hidden: false });
      return () => { cancelled = true; };
    }

    if (!lastGoodOutcomeRef.current && !readLastGoodOutcome(messageId, body)) {
      setPending(true);
    } else {
      keepOrWait();
    }

    void resolvePlaintext({ body, messageId, senderId, isMe, decrypt })
      .then((next) => {
        if (cancelled) return;
        if (!next) {
          keepOrWait();
          return;
        }
        commit(next);
      })
      .catch(() => {
        if (cancelled) return;
        keepOrWait();
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, messageId, senderId, cachedPlaintext, retryTick, refreshKey]);

  const retryNow = () => {
    clearNegativeCache(messageId, body);
    setRecoveryExpired(false);
    silentRetryAttemptRef.current = 0;
    setRetryTick((tick) => tick + 1);
  };

  if (outcome?.hidden) {
    return null;
  }

  if (outcome === null) {
    if (recoveryExpired) {
      return (
        <span
          className="inline-flex min-h-[1.25rem] min-w-[180px] max-w-[280px] flex-col items-start gap-1 text-xs text-muted-foreground"
          role="status"
        >
          <span>Message conservé, synchronisation en attente.</span>
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
      <span
        className="inline-flex min-h-[1.25rem] min-w-[150px] items-center gap-1 text-xs text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        Message en cours de récupération…
      </span>
    );
  }

  const { text, mediaKeyB64 } = outcome;

  if (hasMedia && (isImageMediaLabel(text) || isVideoMediaLabel(text))) {
    return null;
  }

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

  return <span className="whitespace-pre-wrap">{text}</span>;
});
