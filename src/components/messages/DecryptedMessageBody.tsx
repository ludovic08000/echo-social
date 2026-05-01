import { useState, useEffect, useRef, memo } from 'react';
import { VoiceMessagePlayer } from '@/components/chat/VoiceRecorder';
import { hasMediaKey, parseMediaMessage, buildMediaMessageBody } from '@/lib/crypto/mediaEncrypt';
import { isStrictRatchetEnvelopeBody } from '@/lib/messaging/messageCompatibility';
import { savePlaintextForCiphertext, loadPlaintextForCiphertext } from '@/lib/crypto/plaintextStore';
import { tryReadDeviceCopy } from '@/lib/messaging/multiDeviceFanout';
import { routeIncoming } from '@/e2ee-session';
import { supabase } from '@/integrations/supabase/client';
import { setMediaKey } from './mediaKeyCache';
import type { DecryptResult } from '@/hooks/useE2EE';
import { logCryptoError, logCryptoException } from '@/lib/crypto/errorLogger';

function looksEncryptedMessage(body: string): boolean {
  return isStrictRatchetEnvelopeBody(body);
}

interface CachedDecryption {
  text: string;
  mediaKeyB64: string | null;
  hidden: boolean;
}

/**
 * Bounded LRU plaintext cache. Without a cap this grows unbounded across
 * long sessions on iOS PWA (where message bodies stay in RAM for days),
 * eventually triggering OOM kills. 500 entries ≈ a few MB worst-case.
 */
const PLAINTEXT_CACHE_CAP = 500;
class LruMap<K, V> {
  private m = new Map<K, V>();
  constructor(private readonly cap: number) {}
  get(k: K): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k: K, v: V): void {
    if (this.m.has(k)) this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.cap) {
      const oldest = this.m.keys().next().value;
      if (oldest === undefined) break;
      this.m.delete(oldest);
    }
  }
  delete(k: K): void { this.m.delete(k); }
}
const plaintextCache = new LruMap<string, CachedDecryption>(PLAINTEXT_CACHE_CAP);
const inflight = new Map<string, Promise<CachedDecryption | null>>();

function cacheKey(messageId: string | undefined, body: string): string {
  return `${messageId ?? 'noid'}|${body}`;
}

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
  isEncryptionActive,
  onDecrypted,
  isMe,
  cachedPlaintext,
  refreshKey,
  messageId,
  hasMedia,
}: DecryptedMessageBodyProps) {
  const initial = (() => {
    if (cachedPlaintext) {
      if (hasMediaKey(cachedPlaintext)) {
        const parsed = parseMediaMessage(cachedPlaintext);
        if (parsed) {
          if (messageId) {
            setMediaKey(messageId, parsed.keyB64, parsed.label.startsWith('🎬'));
          }
          plaintextCache.set(cacheKey(messageId, body), {
            text: parsed.label,
            mediaKeyB64: parsed.keyB64,
            hidden: false,
          });
          return {
            text: parsed.label,
            mediaKeyB64: parsed.keyB64 as string | null,
            hidden: false,
            decrypting: false,
          };
        }
      }

      return {
        text: cachedPlaintext,
        mediaKeyB64: null as string | null,
        hidden: false,
        decrypting: false,
      };
    }

    if (!looksEncryptedMessage(body)) {
      return {
        text: body,
        mediaKeyB64: null as string | null,
        hidden: false,
        decrypting: false,
      };
    }

    const cached = plaintextCache.get(cacheKey(messageId, body));
    if (cached) {
      if (cached.mediaKeyB64 && messageId) {
        setMediaKey(messageId, cached.mediaKeyB64, cached.text.startsWith('🎬'));
      }
      return {
        text: cached.text,
        mediaKeyB64: cached.mediaKeyB64,
        hidden: cached.hidden,
        decrypting: false,
      };
    }

    return {
      text: null as string | null,
      mediaKeyB64: null as string | null,
      hidden: false,
      decrypting: true,
    };
  })();

  const [displayText, setDisplayText] = useState<string | null>(initial.text);
  const [mediaKeyB64, setMediaKeyB64State] = useState<string | null>(initial.mediaKeyB64);
  const [isDecrypting, setIsDecrypting] = useState(initial.decrypting);
  const [hidden, setHidden] = useState(initial.hidden);
  const [retryTick, setRetryTick] = useState(0);

  const onDecryptedRef = useRef(onDecrypted);
  onDecryptedRef.current = onDecrypted;

  useEffect(() => {
    const handler = () => {
      // Drop any stale cached entry so the next render forces a real attempt.
      // We never store a "restoration needed" placeholder anymore — the
      // pending queue keeps retrying silently — but legacy entries from a
      // prior version may still be in memory.
      const k = cacheKey(messageId, body);
      plaintextCache.delete(k);
      setRetryTick((t) => t + 1);
    };
    window.addEventListener('forsure-decrypt-retry', handler);
    return () => window.removeEventListener('forsure-decrypt-retry', handler);
  }, [messageId, body]);

  useEffect(() => {
    if (cachedPlaintext) {
      if (looksEncryptedMessage(body)) {
        void savePlaintextForCiphertext(body, cachedPlaintext);
      }

      if (hasMediaKey(cachedPlaintext)) {
        const parsed = parseMediaMessage(cachedPlaintext);
        if (parsed) {
          plaintextCache.set(cacheKey(messageId, body), {
            text: parsed.label,
            mediaKeyB64: parsed.keyB64,
            hidden: false,
          });

          if (messageId) {
            setMediaKey(messageId, parsed.keyB64, parsed.label.startsWith('🎬'));
          }

          setHidden(false);
          setDisplayText(parsed.label);
          setMediaKeyB64State(parsed.keyB64);
          setIsDecrypting(false);
          onDecryptedRef.current?.(cachedPlaintext);
          return;
        }
      }

      setHidden(false);
      setDisplayText(cachedPlaintext);
      setMediaKeyB64State(null);
      setIsDecrypting(false);
      onDecryptedRef.current?.(cachedPlaintext);
      return;
    }

    if (!looksEncryptedMessage(body)) {
      setHidden(false);
      setDisplayText(body);
      setMediaKeyB64State(null);
      setIsDecrypting(false);
      return;
    }

    // For our own messages we rely entirely on the volatile plaintext cache
    // populated by the send pipeline. If it isn't there yet, stay silently
    // decrypting (transparent dot) — the cache will populate within a tick
    // and a re-render will show the text. We NEVER surface a placeholder.
    if (isMe) {
      setIsDecrypting(true);
      return;
    }

    const key = cacheKey(messageId, body);

    const cached = plaintextCache.get(key);
    if (cached) {
      setHidden(cached.hidden);
      setDisplayText(cached.text);
      setMediaKeyB64State(cached.mediaKeyB64);
      setIsDecrypting(false);

      if (cached.mediaKeyB64 && messageId) {
        setMediaKey(messageId, cached.mediaKeyB64, cached.text.startsWith('🎬'));
      }

      const persistedText = cached.mediaKeyB64
        ? buildMediaMessageBody(cached.text, cached.mediaKeyB64)
        : cached.text;

      onDecryptedRef.current?.(persistedText);
      return;
    }

    let cancelled = false;
    setIsDecrypting(true);

    let promise = inflight.get(key);

    if (!promise) {
      const buildEntryFromText = (text: string): CachedDecryption => {
        if (hasMediaKey(text)) {
          const parsed = parseMediaMessage(text);
          if (parsed) {
            return { text: parsed.label, mediaKeyB64: parsed.keyB64, hidden: false };
          }
        }
        return { text, mediaKeyB64: null, hidden: false };
      };

      // Single delegate: try the conversation-level decrypt first, then the
      // e2ee-session façade (which itself tries multi-session ratchet
      // enumeration + per-message device-copy fan-out + enqueues for retry).
      // Returns null when no path produced plaintext — the UI then stays in
      // a silent "decrypting" state until `forsure-decrypt-retry` fires.
      const sessionFallback = async (): Promise<CachedDecryption | null> => {
        if (!messageId) return null;
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return null;
          const { data: row } = await supabase
            .from('messages')
            .select('sender_id')
            .eq('id', messageId)
            .maybeSingle();
          const r = await routeIncoming({
            encryptedBody: body,
            recipientUserId: user.id,
            senderUserId: (row as { sender_id?: string } | null)?.sender_id,
            messageId,
          });
          if (r.ok && r.plaintext !== null) return buildEntryFromText(r.plaintext);
        } catch { /* swallow */ }
        return null;
      };

      promise = decrypt(body)
        .then(async (result) => {
          if (!result.incompatible) {
            const entry = buildEntryFromText(result.text);
            plaintextCache.set(key, entry);
            return entry;
          }

          // Conv-ratchet incompatible — try device-copy then full façade.
          if (messageId) {
            const copyText = await tryReadDeviceCopy(messageId);
            if (copyText !== null) {
              const entry = buildEntryFromText(copyText);
              plaintextCache.set(key, entry);
              return entry;
            }
          }

          const facade = await sessionFallback();
          if (facade) {
            plaintextCache.set(key, facade);
            return facade;
          }

          logCryptoError({
            severity: 'warning',
            context: 'decrypt',
            errorCode: 'E_DECRYPT_PENDING',
            errorMessage: 'No path decrypted — staying silent, pending queue will retry',
            metadata: { messageId, bodyLen: body.length },
          });
          // Returning null tells the UI to stay in silent decrypting state.
          return null;
        })
        .catch(async (err) => {
          // Hard error from conv-ratchet — try façade once.
          const facade = await sessionFallback();
          if (facade) {
            plaintextCache.set(key, facade);
            return facade;
          }
          logCryptoException('decrypt', err, {
            severity: 'error',
            metadata: { messageId, bodyLen: body.length, stage: 'final_fallback' },
          });
          return null;
        });

      inflight.set(key, promise);
      promise.finally(() => inflight.delete(key));
    }

    promise
      .then((entry) => {
        if (cancelled) return;

        if (!entry) {
          // Stay silently decrypting — pending queue + retry event will resolve.
          setHidden(false);
          setDisplayText(null);
          setMediaKeyB64State(null);
          setIsDecrypting(true);
          return;
        }

        setHidden(entry.hidden);
        setDisplayText(entry.hidden ? null : entry.text);
        setMediaKeyB64State(entry.mediaKeyB64);
        setIsDecrypting(false);

        if (entry.mediaKeyB64 && messageId) {
          setMediaKey(messageId, entry.mediaKeyB64, entry.text.startsWith('🎬'));
        }

        if (!entry.hidden) {
          const persistedText = entry.mediaKeyB64
            ? buildMediaMessageBody(entry.text, entry.mediaKeyB64)
            : entry.text;

          void savePlaintextForCiphertext(body, persistedText);
          onDecryptedRef.current?.(persistedText);
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Stay silent on unexpected errors too.
          setIsDecrypting(true);
        }
      });

    return () => {
      cancelled = true;
    };
    // `retryTick` + `refreshKey` force a re-attempt after key restoration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, messageId, cachedPlaintext, retryTick, refreshKey]);

  if (hidden) return null;

  if (isDecrypting || displayText === null) {
    return <span className="opacity-0 select-none">·</span>;
  }

  if (hasMedia && (displayText === '📷 Photo' || displayText === '🎬 Vidéo')) {
    return null;
  }

  const voice = parseVoiceMessage(displayText);
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

  const gifUrl = parseGifMessage(displayText);
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

  return <>{displayText}</>;
});
