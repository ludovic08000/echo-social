/**
 * MessageMedia — renders media attached to a message.
 *
 * For encrypted conversations, it first checks the per-message media-key cache
 * (populated by DecryptedMessageBody). If absent, it falls back to decrypting
 * the body itself. This eliminates double-decryption of the same envelope.
 */

import { useState, useEffect, memo } from 'react';
import { EncryptedMedia } from './EncryptedMedia';
import { parseMediaMessage } from '@/lib/crypto/mediaEncrypt';
import { isStrictRatchetEnvelopeBody } from '@/lib/messaging/messageCompatibility';
import { getMediaKey } from './mediaKeyCache';
import type { DecryptResult } from '@/hooks/useE2EE';

function looksEncryptedMessage(body: string): boolean {
  return isStrictRatchetEnvelopeBody(body);
}

interface MessageMediaProps {
  imageUrl: string;
  body: string;
  decrypt: (body: string) => Promise<DecryptResult>;
  isEncryptionActive: boolean;
  /** Message id — enables sharing the decrypted media key across components */
  messageId?: string;
}

export const MessageMedia = memo(function MessageMedia({
  imageUrl,
  body,
  decrypt,
  isEncryptionActive,
  messageId,
}: MessageMediaProps) {
  const [mediaKey, setMediaKey] = useState<string | null>(() => {
    if (!messageId) return null;
    const cached = getMediaKey(messageId);
    return cached?.mediaKeyB64 ?? null;
  });
  const [isVideo, setIsVideo] = useState<boolean>(() => {
    if (!messageId) return false;
    return getMediaKey(messageId)?.isVideo ?? false;
  });
  const [resolved, setResolved] = useState<boolean>(() => {
    if (!isEncryptionActive) return true;
    if (messageId && getMediaKey(messageId)) return true;
    return false;
  });

  useEffect(() => {
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

    const shouldAttemptDecrypt = isEncryptionActive || looksEncryptedMessage(body);

    if (!shouldAttemptDecrypt || !looksEncryptedMessage(body)) {
      setResolved(true);
      return;
    }

    // Poll the cache briefly: DecryptedMessageBody may resolve very shortly
    // after MessageMedia mounts. This avoids triggering a redundant decrypt.
    let cancelled = false;
    let attempts = 0;
    const tryCache = (): boolean => {
      if (!messageId) return false;
      const cached = getMediaKey(messageId);
      if (cached) {
        setMediaKey(cached.mediaKeyB64);
        setIsVideo(cached.isVideo);
        setResolved(true);
        return true;
      }
      return false;
    };

    const interval = setInterval(() => {
      if (cancelled) return;
      if (tryCache() || attempts++ > 20) {
        clearInterval(interval);
        if (!cancelled && !tryCache()) {
          // Last-resort fallback: decrypt ourselves (rare path)
          decrypt(body).then(result => {
            if (cancelled) return;
            if (result.incompatible) { setResolved(true); return; }
            const parsed = parseMediaMessage(result.text);
            if (parsed) {
              setMediaKey(parsed.keyB64);
              setIsVideo(parsed.label.startsWith('🎬'));
            }
            setResolved(true);
          }).catch(() => {
            if (!cancelled) setResolved(true);
          });
        }
      }
    }, 50);

    return () => { cancelled = true; clearInterval(interval); };
  }, [body, decrypt, isEncryptionActive, messageId]);

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
