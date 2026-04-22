import { useState, useEffect, useRef, memo } from 'react';
import { Lock } from 'lucide-react';
import { VoiceMessagePlayer } from '@/components/chat/VoiceRecorder';
import { hasMediaKey, parseMediaMessage } from '@/lib/crypto/mediaEncrypt';
import { isStrictRatchetEnvelopeBody } from '@/lib/messaging/messageCompatibility';
import { savePlaintextForCiphertext } from '@/lib/crypto/plaintextStore';
import { tryReadDeviceCopy } from '@/lib/messaging/multiDeviceFanout';
import { setMediaKey } from './mediaKeyCache';
import type { DecryptResult } from '@/hooks/useE2EE';
import { logCryptoError, logCryptoException } from '@/lib/crypto/errorLogger';

function looksEncryptedMessage(body: string): boolean {
  return isStrictRatchetEnvelopeBody(body);
}

/**
 * Module-level plaintext cache, keyed by `${messageId}|${body}`.
 * Once a message is decrypted, we never re-decrypt or re-flash "Déchiffrement…".
 * The `body` part of the key guarantees an edited/replaced ciphertext invalidates.
 */
interface CachedDecryption {
  text: string;
  mediaKeyB64: string | null;
  hidden: boolean;
}
const plaintextCache = new Map<string, CachedDecryption>();
const inflight = new Map<string, Promise<CachedDecryption>>();

// Bumped whenever the E2EE key material is restored / rotated. Components
// listen via useEffect and re-run their decryption pipeline. We also drop
// any cache entry that resolved to "hidden" since those were placeholders
// produced while the keys were still missing.
let cacheGeneration = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('forsure-keys-restored', () => {
    for (const [k, v] of plaintextCache) {
      if (v.hidden) plaintextCache.delete(k);
    }
    cacheGeneration += 1;
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry'));
  });
}

function cacheKey(messageId: string | undefined, body: string): string {
  return `${messageId ?? 'noid'}|${body}`;
}

/** Detect voice message pattern — supports multiple formats:
 *  🎙️ vocal:URL|duration
 *  🎙️ voice:URL|dur:duration
 *  🎙️ voice:URL|duration
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
  if (match) return match[1];
  return null;
}

interface DecryptedMessageBodyProps {
  body: string;
  decrypt: (body: string) => Promise<DecryptResult>;
  isEncryptionActive: boolean;
  onDecrypted?: (text: string) => void;
  isMe?: boolean;
  /** Pre-cached plaintext for own sent messages (ratchet can't self-decrypt) */
  cachedPlaintext?: string;
  /** Changes when E2EE state self-heals so decryption retries automatically */
  refreshKey?: string | number;
  /** Message id — used to share the extracted media key with MessageMedia */
  messageId?: string;
  /** Indicates the message has an attached media (image_url) */
  hasMedia?: boolean;
}

export const DecryptedMessageBody = memo(function DecryptedMessageBody({
  body,
  decrypt,
  isEncryptionActive,
  onDecrypted,
  isMe,
  cachedPlaintext,
  messageId,
  hasMedia,
}: DecryptedMessageBodyProps) {
  // Compute the initial state synchronously from the cache so we never
  // flash "Déchiffrement…" on a message that's already been decrypted.
  const initial = (() => {
    if (cachedPlaintext) {
      // If the cached plaintext embeds a media key, surface it synchronously
      // so MessageMedia (rendered in the same cycle) can pick it up from the
      // shared mediaKeyCache during its own initial render — avoids flashing
      // raw "📷 Photo\x00MKEY:..." text and the broken-image fallback.
      if (hasMediaKey(cachedPlaintext)) {
        const parsed = parseMediaMessage(cachedPlaintext);
        if (parsed) {
          if (messageId) setMediaKey(messageId, parsed.keyB64, parsed.label.startsWith('🎬'));
          plaintextCache.set(cacheKey(messageId, body), {
            text: parsed.label,
            mediaKeyB64: parsed.keyB64,
            hidden: false,
          });
          return { text: parsed.label, mediaKeyB64: parsed.keyB64 as string | null, hidden: false, decrypting: false };
        }
      }
      return { text: cachedPlaintext, mediaKeyB64: null as string | null, hidden: false, decrypting: false };
    }
    const looksEnc = looksEncryptedMessage(body);
    if (!looksEnc) {
      return { text: body, mediaKeyB64: null as string | null, hidden: false, decrypting: false };
    }
    const cached = plaintextCache.get(cacheKey(messageId, body));
    if (cached) {
      if (cached.mediaKeyB64 && messageId) setMediaKey(messageId, cached.mediaKeyB64, cached.text.startsWith('🎬'));
      return { text: cached.text, mediaKeyB64: cached.mediaKeyB64, hidden: cached.hidden, decrypting: false };
    }
    if (isMe) {
      return { text: null as string | null, mediaKeyB64: null as string | null, hidden: false, decrypting: true };
    }
    return { text: null as string | null, mediaKeyB64: null as string | null, hidden: false, decrypting: true };
  })();

  const [displayText, setDisplayText] = useState<string | null>(initial.text);
  const [mediaKeyB64, setMediaKeyB64State] = useState<string | null>(initial.mediaKeyB64);
  const [isDecrypting, setIsDecrypting] = useState(initial.decrypting);
  const [hidden, setHidden] = useState(initial.hidden);
  const [retryTick, setRetryTick] = useState(0);
  const onDecryptedRef = useRef(onDecrypted);
  onDecryptedRef.current = onDecrypted;

  // Listen for E2EE key restoration so we re-attempt decryption after login.
  useEffect(() => {
    const handler = () => setRetryTick(t => t + 1);
    window.addEventListener('forsure-decrypt-retry', handler);
    return () => window.removeEventListener('forsure-decrypt-retry', handler);
  }, []);

  useEffect(() => {
    // Re-run only when the actual identity of the message changes.
    if (cachedPlaintext) {
      if (looksEncryptedMessage(body)) {
        void savePlaintextForCiphertext(body, cachedPlaintext);
      }
      // If the cached plaintext embeds a media key, surface it so the attached
      // image/video gets decrypted in-place (works for own sent messages too).
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
          onDecryptedRef.current?.(parsed.label);
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

    // Own message after reload: ratchet can't self-decrypt. The parent will
    // load the plaintext from the persistent device-encrypted store and feed
    // it back via cachedPlaintext. Wait briefly; if it still isn't available
    // (sent from another device), render an invisible placeholder — the user
    // never sees a "contenu effacé" label.
    if (isMe) {
      setIsDecrypting(true);
      const fallbackTimer = setTimeout(() => {
        const entry: CachedDecryption = {
          text: '',
          mediaKeyB64: null,
          hidden: true,
        };
        plaintextCache.set(cacheKey(messageId, body), entry);
        setHidden(true);
        setDisplayText('');
        setMediaKeyB64State(null);
        setIsDecrypting(false);
      }, 800);
      return () => clearTimeout(fallbackTimer);
    }

    const key = cacheKey(messageId, body);

    // Hot path — already decrypted
    const cached = plaintextCache.get(key);
    if (cached) {
      setHidden(cached.hidden);
      setDisplayText(cached.text);
      setMediaKeyB64State(cached.mediaKeyB64);
      setIsDecrypting(false);
      if (cached.mediaKeyB64 && messageId) {
        const parsed = parseMediaMessage(cached.text);
        if (parsed) setMediaKey(messageId, parsed.keyB64, parsed.label.startsWith('🎬'));
      }
      onDecryptedRef.current?.(cached.text);
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

      promise = decrypt(body).then(async result => {
        // Multi-device fallback: ratchet was incompatible (typical on a
        // secondary device that has no ratchet state). Try the per-device copy.
        if (result.incompatible && messageId) {
          const copyText = await tryReadDeviceCopy(messageId);
          if (copyText !== null) {
            const entry = buildEntryFromText(copyText);
            plaintextCache.set(key, entry);
            return entry;
          }
          logCryptoError({
            severity: 'error',
            context: 'decrypt',
            errorCode: 'E_DECRYPT_NO_COPY',
            errorMessage: 'Ratchet incompatible and no device copy found — message hidden from receiver',
            metadata: { messageId, bodyLen: body.length },
          });
          const entry: CachedDecryption = { text: '', mediaKeyB64: null, hidden: true };
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
          const entry: CachedDecryption = { text: '', mediaKeyB64: null, hidden: true };
          plaintextCache.set(key, entry);
          return entry;
        }
        const entry = buildEntryFromText(result.text);
        plaintextCache.set(key, entry);
        return entry;
      }).catch(async (err) => {
        // Hard ratchet failure → try device copy before giving up.
        if (messageId) {
          const copyText = await tryReadDeviceCopy(messageId);
          if (copyText !== null) {
            const entry = buildEntryFromText(copyText);
            plaintextCache.set(key, entry);
            return entry;
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

    promise.then(entry => {
      if (cancelled) return;
      setHidden(entry.hidden);
      setDisplayText(entry.hidden ? null : entry.text);
      setMediaKeyB64State(entry.mediaKeyB64);
      setIsDecrypting(false);
      if (entry.mediaKeyB64 && messageId) {
        // entry.text is already the parsed label (e.g. "📷 Photo" / "🎬 Vidéo"),
        // and entry.mediaKeyB64 is the per-file AES key. Push directly to cache.
        setMediaKey(messageId, entry.mediaKeyB64, entry.text.startsWith('🎬'));
      }
      if (!entry.hidden) {
        void savePlaintextForCiphertext(body, entry.text);
        onDecryptedRef.current?.(entry.text);
      }
    }).catch(() => {
      if (!cancelled) {
        setDisplayText('🔒 Message chiffré');
        setMediaKeyB64State(null);
        setIsDecrypting(false);
      }
    });

    return () => { cancelled = true; };
    // Deliberately exclude `decrypt`, `isEncryptionActive`, `refreshKey`, `isMe`
    // from deps: they change during E2EE auto-heal and would re-trigger the
    // "Déchiffrement…" flash even though the cached plaintext is valid.
    // `retryTick` is included so we retry after key restoration on login.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, messageId, cachedPlaintext, retryTick]);

  if (hidden) return null;

  // Silent placeholder while decryption is in flight — no visible spinner or
  // "Déchiffrement…" text. The decryption pipeline runs invisibly in the
  // background; users only ever see plaintext, never the crypto state.
  if (isDecrypting || displayText === null) {
    return <span className="opacity-0 select-none">·</span>;
  }

  // Hide raw media labels ("📷 Photo" / "🎬 Vidéo") when a media is attached —
  // the image/video preview itself is the content; the label is redundant noise.
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
