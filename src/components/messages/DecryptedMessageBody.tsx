import { useState, useEffect, useRef, memo } from 'react';
import { VoiceMessagePlayer } from '@/components/chat/VoiceRecorder';
import { hasMediaKey, parseMediaMessage, buildMediaMessageBody } from '@/lib/crypto/mediaEncrypt';
import { isStrictRatchetEnvelopeBody } from '@/lib/messaging/messageCompatibility';
import { savePlaintextForCiphertext } from '@/lib/crypto/plaintextStore';
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

const plaintextCache = new Map<string, CachedDecryption>();
const inflight = new Map<string, Promise<CachedDecryption>>();

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
    const handler = () => setRetryTick((t) => t + 1);
    window.addEventListener('forsure-decrypt-retry', handler);
    return () => window.removeEventListener('forsure-decrypt-retry', handler);
  }, []);

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

    if (isMe) {
      setIsDecrypting(true);

      const fallbackTimer = setTimeout(() => {
        const entry: CachedDecryption = {
          text: '🔒 Message sécurisé — restauration nécessaire',
          mediaKeyB64: null,
          hidden: false,
        };
        plaintextCache.set(cacheKey(messageId, body), entry);
        setHidden(false);
        setDisplayText(entry.text);
        setMediaKeyB64State(null);
        setIsDecrypting(false);
      }, 800);

      return () => clearTimeout(fallbackTimer);
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
            return {
              text: parsed.label,
              mediaKeyB64: parsed.keyB64,
              hidden: false,
            };
          }
        }

        return {
          text,
          mediaKeyB64: null,
          hidden: false,
        };
      };

      // Last-resort fallback used by both branches below: try the e2ee-session
      // façade (multi-session ratchet enumeration + pending queue) before
      // surfacing the "restauration nécessaire" placeholder. Never throws.
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
        } catch {
          /* swallow */
        }
        return null;
      };

      promise = decrypt(body)
        .then(async (result) => {
          if (result.incompatible && messageId) {
            const copyText = await tryReadDeviceCopy(messageId);
            if (copyText !== null) {
              const entry = buildEntryFromText(copyText);
              plaintextCache.set(key, entry);
              return entry;
            }

            // NEW: ask the session façade to try every known ratchet session
            // (covers iOS Keychain rotation + multi-device drift).
            const facade = await sessionFallback();
            if (facade) {
              plaintextCache.set(key, facade);
              return facade;
            }

            logCryptoError({
              severity: 'error',
              context: 'decrypt',
              errorCode: 'E_DECRYPT_NO_COPY',
              errorMessage: 'Ratchet incompatible and no device copy found — secure placeholder shown',
              metadata: { messageId, bodyLen: body.length },
            });

            const entry: CachedDecryption = {
              text: '🔒 Message sécurisé — restauration nécessaire',
              mediaKeyB64: null,
              hidden: false,
            };
            plaintextCache.set(key, entry);
            return entry;
          }

          if (result.incompatible) {
            logCryptoError({
              severity: 'warning',
              context: 'decrypt',
              errorCode: 'E_DECRYPT_INCOMPATIBLE',
              errorMessage: 'Ratchet flagged incompatible (no messageId — cannot fallback)',
              metadata: { bodyLen: body.length },
            });

            const entry: CachedDecryption = {
              text: '🔒 Message sécurisé — restauration nécessaire',
              mediaKeyB64: null,
              hidden: false,
            };
            plaintextCache.set(key, entry);
            return entry;
          }

          const entry = buildEntryFromText(result.text);
          plaintextCache.set(key, entry);
          return entry;
        })
        .catch(async (err) => {
          if (messageId) {
            const copyText = await tryReadDeviceCopy(messageId);
            if (copyText !== null) {
              const entry = buildEntryFromText(copyText);
              plaintextCache.set(key, entry);
              return entry;
            }
            // NEW: session façade fallback also on hard errors
            const facade = await sessionFallback();
            if (facade) {
              plaintextCache.set(key, facade);
              return facade;
            }
          }

          logCryptoException('decrypt', err, {
            severity: 'error',
            metadata: { messageId, bodyLen: body.length, stage: 'final_fallback' },
          });

          throw err;
        });

      inflight.set(key, promise);
      promise.finally(() => inflight.delete(key));
    }

    promise
      .then((entry) => {
        if (cancelled) return;

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
          setHidden(false);
          setDisplayText('🔒 Message sécurisé — restauration nécessaire');
          setMediaKeyB64State(null);
          setIsDecrypting(false);
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
