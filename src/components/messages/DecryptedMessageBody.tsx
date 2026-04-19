import { useState, useEffect, useRef, memo } from 'react';
import { Lock } from 'lucide-react';
import { VoiceMessagePlayer } from '@/components/chat/VoiceRecorder';
import { hasMediaKey, parseMediaMessage } from '@/lib/crypto/mediaEncrypt';
import { isStrictRatchetEnvelopeBody } from '@/lib/messaging/messageCompatibility';
import { setMediaKey } from './mediaKeyCache';
import type { DecryptResult } from '@/hooks/useE2EE';

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
}: DecryptedMessageBodyProps) {
  // Compute the initial state synchronously from the cache so we never
  // flash "Déchiffrement…" on a message that's already been decrypted.
  const initial = (() => {
    if (cachedPlaintext) {
      return { text: cachedPlaintext, mediaKeyB64: null as string | null, hidden: false, decrypting: false };
    }
    const looksEnc = looksEncryptedMessage(body);
    if (!looksEnc) {
      return { text: body, mediaKeyB64: null as string | null, hidden: false, decrypting: false };
    }
    const cached = plaintextCache.get(cacheKey(messageId, body));
    if (cached) {
      return { text: cached.text, mediaKeyB64: cached.mediaKeyB64, hidden: cached.hidden, decrypting: false };
    }
    // Own encrypted message: ratchet can't self-decrypt. We rely on the
    // persistent plaintext store loaded asynchronously by the parent.
    // Show the decrypting state until cachedPlaintext arrives (or stays empty).
    if (isMe) {
      return { text: null as string | null, mediaKeyB64: null as string | null, hidden: false, decrypting: true };
    }
    return { text: null as string | null, mediaKeyB64: null as string | null, hidden: false, decrypting: true };
  })();

  const [displayText, setDisplayText] = useState<string | null>(initial.text);
  const [mediaKeyB64, setMediaKeyB64State] = useState<string | null>(initial.mediaKeyB64);
  const [isDecrypting, setIsDecrypting] = useState(initial.decrypting);
  const [hidden, setHidden] = useState(initial.hidden);
  const onDecryptedRef = useRef(onDecrypted);
  onDecryptedRef.current = onDecrypted;

  useEffect(() => {
    // Re-run only when the actual identity of the message changes.
    if (cachedPlaintext) {
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
      promise = decrypt(body).then(result => {
        if (result.incompatible) {
          const entry: CachedDecryption = { text: '', mediaKeyB64: null, hidden: true };
          plaintextCache.set(key, entry);
          return entry;
        }
        if (hasMediaKey(result.text)) {
          const parsed = parseMediaMessage(result.text);
          if (parsed) {
            const entry: CachedDecryption = {
              text: parsed.label,
              mediaKeyB64: parsed.keyB64,
              hidden: false,
            };
            plaintextCache.set(key, entry);
            return entry;
          }
        }
        const entry: CachedDecryption = { text: result.text, mediaKeyB64: null, hidden: false };
        plaintextCache.set(key, entry);
        return entry;
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
        const parsed = parseMediaMessage(entry.text);
        if (parsed) setMediaKey(messageId, parsed.keyB64, parsed.label.startsWith('🎬'));
      }
      if (!entry.hidden) onDecryptedRef.current?.(entry.text);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, messageId, cachedPlaintext]);

  if (hidden) return null;

  // Silent placeholder while decryption is in flight — no visible spinner or
  // "Déchiffrement…" text. The decryption pipeline runs invisibly in the
  // background; users only ever see plaintext, never the crypto state.
  if (isDecrypting || displayText === null) {
    return <span className="opacity-0 select-none">·</span>;
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
