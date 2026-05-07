/**
 * MessageMedia — renders media attached to a message.
 *
 * For encrypted conversations, it first checks the per-message media-key cache
 * (populated by DecryptedMessageBody). If absent, it falls back to decrypting
 * the body itself. This eliminates double-decryption of the same envelope.
 */

import { useState, useEffect, memo } from 'react';
import { EncryptedMedia } from './EncryptedMedia';
import { isVideoMediaLabel, parseMediaMessage } from '@/lib/crypto/mediaEncrypt';
import { isStrictRatchetEnvelopeBody } from '@/lib/messaging/messageCompatibility';
import { getMediaKey, subscribeMediaKey } from './mediaKeyCache';
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
  // Try to extract a media key directly from the body — covers the case
  // where the message was inserted in compatibility mode (encrypt failed
  // upstream, body contains label + \x00MKEY:keyB64 in clear).
  const inlineMedia = (() => {
    if (!body) return null;
    return parseMediaMessage(body);
  })();

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

    // Inline plaintext body containing MKEY (compatibility-send fallback).
    if (inlineMedia) {
      setMediaKey(inlineMedia.keyB64);
      setIsVideo(isVideoMediaLabel(inlineMedia.label));
      setResolved(true);
      return;
    }

    const shouldAttemptDecrypt = isEncryptionActive || looksEncryptedMessage(body);

    if (!shouldAttemptDecrypt || !looksEncryptedMessage(body)) {
      setResolved(true);
      return;
    }

    let cancelled = false;

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
      decrypt(body).then(result => {
        if (cancelled) return;
        if (result.incompatible || (result.encrypted && !result.verified)) { setResolved(true); return; }
        const parsed = parseMediaMessage(result.text);
        if (parsed) {
          setMediaKey(parsed.keyB64);
          setIsVideo(isVideoMediaLabel(parsed.label));
        }
        setResolved(true);
      }).catch(() => {
        if (!cancelled) setResolved(true);
      });
    }, 1000);

    return () => { cancelled = true; unsubscribe(); clearTimeout(fallbackTimer); };
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
