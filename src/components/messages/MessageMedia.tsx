/**
 * MessageMedia — renders media attached to a message.
 *
 * For encrypted conversations, it first checks the per-message media-key cache
 * (populated by DecryptedMessageBody). If absent, it falls back to decrypting
 * the body itself. This eliminates double-decryption of the same envelope.
 */

import { useState, useEffect, memo, useMemo } from 'react';
import { Lock } from 'lucide-react';
import { EncryptedMedia } from './EncryptedMedia';
import { isVideoMediaLabel, parseMediaMessage } from '@/lib/crypto/mediaEncrypt';
import { getMediaKey, subscribeMediaKey } from './mediaKeyCache';
import { loadPlaintext } from '@/lib/crypto/plaintextStore';
import { looksEncrypted as looksEncryptedMessage, resolvePlaintext } from './decryptionService';
import type { DecryptResult } from '@/hooks/useE2EE';

interface MessageMediaProps {
  imageUrl: string;
  body: string;
  decrypt: (body: string) => Promise<DecryptResult>;
  isEncryptionActive: boolean;
  /** Message id — enables sharing the decrypted media key across components */
  messageId?: string;
  /** Plaintext already known by the parent, especially for our own just-sent media */
  cachedPlaintext?: string;
}

export const MessageMedia = memo(function MessageMedia({
  imageUrl,
  body,
  decrypt,
  isEncryptionActive,
  messageId,
  cachedPlaintext,
}: MessageMediaProps) {
  // Try to extract a media key directly from the body — covers the case
  // where the message was inserted in compatibility mode (encrypt failed
  // upstream, body contains label + \x00MKEY:keyB64 in clear).
  const inlineMedia = useMemo(() => {
    const source = cachedPlaintext || (!isEncryptionActive ? body : '');
    if (!source) return null;
    return parseMediaMessage(source);
  }, [body, cachedPlaintext, isEncryptionActive]);

  const [mediaKey, setMediaKey] = useState<string | null>(() => {
    if (messageId) {
      const cached = getMediaKey(messageId);
      if (cached) return cached.mediaKeyB64;
    }
    return inlineMedia?.keyB64 ?? null;
  });
  const [isVideo, setIsVideo] = useState<boolean>(() => {
    if (messageId) {
      const cached = getMediaKey(messageId);
      if (cached) return cached.isVideo;
    }
    return inlineMedia ? isVideoMediaLabel(inlineMedia.label) : false;
  });
  const [resolved, setResolved] = useState<boolean>(() => {
    if (!isEncryptionActive) return true;
    if (messageId && getMediaKey(messageId)) return true;
    if (inlineMedia) return true;
    return false;
  });
  const [retryTick, setRetryTick] = useState(0);

  // Re-run resolution when keys are restored (e.g. after PIN unlock) — without
  // this, a media that resolved as "no key" while locked would stay broken
  // until a manual refresh.
  useEffect(() => {
    const handler = () => {
      setMediaKey(null);
      setResolved(false);
      setRetryTick((t) => t + 1);
    };
    window.addEventListener('forsure-decrypt-retry', handler);
    window.addEventListener('forsure-keys-unlocked', handler);
    return () => {
      window.removeEventListener('forsure-decrypt-retry', handler);
      window.removeEventListener('forsure-keys-unlocked', handler);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Fast path — DecryptedMessageBody already resolved the media key.
    if (messageId) {
      const cached = getMediaKey(messageId);
      if (cached) {
        setMediaKey(cached.mediaKeyB64);
        setIsVideo(cached.isVideo);
        setResolved(true);
        return;
      }
    }

    // Inline/cached plaintext body containing MKEY (compatibility-send fallback
    // and self-sent media: sender cannot decrypt their own outbound ratchet copy).
    if (inlineMedia) {
      setMediaKey(inlineMedia.keyB64);
      setIsVideo(isVideoMediaLabel(inlineMedia.label));
      setResolved(true);
      return;
    }

    // Local persistent plaintext cache keyed by message id — populated right
    // after send. This is the reliable path for our own outgoing encrypted media.
    if (messageId) {
      void loadPlaintext(messageId).then((plain) => {
        if (cancelled || !plain) return;
        const parsed = parseMediaMessage(plain);
        if (!parsed) return;
        setMediaKey(parsed.keyB64);
        setIsVideo(isVideoMediaLabel(parsed.label));
        setResolved(true);
      });
    }

    // Subscribe before any early return: multi-device parent envelopes do not
    // look like strict ratchet bodies, but DecryptedMessageBody can still
    // recover their per-device copy and publish the media key later.
    const earlyUnsubscribe = messageId
      ? subscribeMediaKey(messageId, (entry) => {
          if (cancelled) return;
          setMediaKey(entry.mediaKeyB64);
          setIsVideo(entry.isVideo);
          setResolved(true);
        })
      : () => {};

    const shouldAttemptDecrypt = isEncryptionActive || looksEncryptedMessage(body);

    if (!shouldAttemptDecrypt || !looksEncryptedMessage(body)) {
      setResolved(true);
      return () => { cancelled = true; earlyUnsubscribe(); };
    }

    // Subscribe — DecryptedMessageBody pushes the key the moment it's ready.
    const unsubscribe = messageId
      ? subscribeMediaKey(messageId, (entry) => {
          if (cancelled) return;
          setMediaKey(entry.mediaKeyB64);
          setIsVideo(entry.isVideo);
          setResolved(true);
        })
      : () => {};

    // Last-resort fallback: decrypt ourselves if no key arrives in 1s.
    const fallbackTimer = setTimeout(() => {
      if (cancelled) return;
      if (messageId && getMediaKey(messageId)) return;
      resolvePlaintext({ body, messageId, decrypt }).then(result => {
        if (cancelled) return;
        if (result?.mediaKeyB64) {
          setMediaKey(result.mediaKeyB64);
          setIsVideo(isVideoMediaLabel(result.text));
        }
        setResolved(true);
      }).catch(() => {
        if (!cancelled) setResolved(true);
      });
    }, 1000);

    return () => { cancelled = true; earlyUnsubscribe(); unsubscribe(); clearTimeout(fallbackTimer); };
  }, [body, cachedPlaintext, decrypt, inlineMedia, isEncryptionActive, messageId, retryTick]);

  if (!resolved) return null;

  if (mediaKey) {
    return (
      <EncryptedMedia
        encryptedUrl={imageUrl}
        mediaKeyB64={mediaKey}
        isVideo={isVideo}
      />
    );
  }

  if (isEncryptionActive) {
    return (
      <div className="flex items-center justify-center gap-2 p-4 rounded-lg bg-muted/50 min-h-[72px] max-w-full">
        <Lock className="w-4 h-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Média chiffré en attente de clé</span>
      </div>
    );
  }

  const isVideoFile = /\.(mp4|mov|webm|avi|mkv)/i.test(imageUrl);
  if (isVideoFile) {
    return (
      <video
        src={imageUrl}
        controls
        playsInline
        preload="metadata"
        className="max-w-full max-h-[300px] rounded-[18px]"
      />
    );
  }

  return (
    <img src={imageUrl} alt="Photo" className="max-w-full max-h-[300px] object-cover" />
  );
});
