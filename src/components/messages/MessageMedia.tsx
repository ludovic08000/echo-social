/**
 * MessageMedia — renders media attached to a message.
 *
 * For encrypted conversations, it first checks the per-message media-key cache
 * (populated by DecryptedMessageBody). If absent, it falls back to decrypting
 * the body itself. This eliminates double-decryption of the same envelope.
 */

import { useState, useEffect, memo } from 'react';
import { Lock } from 'lucide-react';
import { EncryptedMedia } from './EncryptedMedia';
import { isVideoMediaLabel, parseMediaMessage } from '@/lib/crypto/mediaEncrypt';
import { isOutboundEncryptedBody } from '@/lib/messaging/messageCompatibility';
import { getMediaKey, subscribeMediaKey } from './mediaKeyCache';
import type { DecryptResult } from '@/hooks/useE2EE';

function looksEncryptedMessage(body: string): boolean {
  return isOutboundEncryptedBody(body);
}

function LockedMediaPlaceholder() {
  return (
    <div
      className="flex items-center justify-center gap-2 p-4 rounded-lg bg-muted/50 border border-border/40 min-h-[72px] max-w-full"
      aria-label="Media chiffre en attente"
    >
      <Lock className="w-4 h-4 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">Media chiffre en attente</span>
    </div>
  );
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
  const isEncryptedContext = isEncryptionActive || looksEncryptedMessage(body);
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
    if (!isEncryptedContext) return true;
    if (messageId && getMediaKey(messageId)) return true;
    return false;
  });

  useEffect(() => {
    const encryptedContext = isEncryptionActive || looksEncryptedMessage(body);

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

    if (!encryptedContext || !looksEncryptedMessage(body)) {
      setMediaKey(null);
      setResolved(true);
      return;
    }

    setResolved(false);
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

  if (isEncryptedContext) {
    return <LockedMediaPlaceholder />;
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
