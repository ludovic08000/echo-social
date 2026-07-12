/**
 * MessageMedia — renders media attached to a message.
 *
 * Media Hold invariant: once a valid media key is known, unrelated/global
 * decrypt retries must not clear it or collapse the bubble.
 */

import { useState, useEffect, memo, useMemo, useRef } from 'react';
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
  messageId?: string;
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
  const inlineMedia = useMemo(() => {
    const source = cachedPlaintext || (!isEncryptionActive ? body : '');
    if (!source) return null;
    return parseMediaMessage(source);
  }, [body, cachedPlaintext, isEncryptionActive]);

  const initialCached = messageId ? getMediaKey(messageId) : undefined;
  const [mediaKey, setMediaKey] = useState<string | null>(
    initialCached?.mediaKeyB64 ?? inlineMedia?.keyB64 ?? null,
  );
  const [isVideo, setIsVideo] = useState<boolean>(
    initialCached?.isVideo ?? (inlineMedia ? isVideoMediaLabel(inlineMedia.label) : false),
  );
  const [resolved, setResolved] = useState<boolean>(
    !isEncryptionActive || Boolean(initialCached || inlineMedia),
  );
  const [retryTick, setRetryTick] = useState(0);
  const mediaKeyRef = useRef<string | null>(mediaKey);
  mediaKeyRef.current = mediaKey;

  useEffect(() => {
    const handler = (event: Event) => {
      const target = (event as CustomEvent<{ messageId?: string }>).detail?.messageId;
      if (target && messageId && target !== messageId) return;

      // Preserve a positive key. A retry only wakes unresolved media.
      const cached = messageId ? getMediaKey(messageId) : undefined;
      if (!cached && !mediaKeyRef.current) setResolved(false);
      setRetryTick((tick) => tick + 1);
    };
    window.addEventListener('forsure-decrypt-retry', handler);
    window.addEventListener('forsure-keys-unlocked', handler);
    return () => {
      window.removeEventListener('forsure-decrypt-retry', handler);
      window.removeEventListener('forsure-keys-unlocked', handler);
    };
  }, [messageId]);

  useEffect(() => {
    let cancelled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const acceptKey = (keyB64: string, video: boolean) => {
      if (cancelled) return;
      mediaKeyRef.current = keyB64;
      setMediaKey(keyB64);
      setIsVideo(video);
      setResolved(true);
    };

    const unsubscribe = messageId
      ? subscribeMediaKey(messageId, (entry) => acceptKey(entry.mediaKeyB64, entry.isVideo))
      : () => {};

    const cached = messageId ? getMediaKey(messageId) : undefined;
    if (cached) {
      acceptKey(cached.mediaKeyB64, cached.isVideo);
      return () => { cancelled = true; unsubscribe(); };
    }

    if (inlineMedia) {
      acceptKey(inlineMedia.keyB64, isVideoMediaLabel(inlineMedia.label));
      return () => { cancelled = true; unsubscribe(); };
    }

    if (messageId) {
      void loadPlaintext(messageId).then((plain) => {
        if (cancelled || !plain) return;
        const parsed = parseMediaMessage(plain);
        if (parsed) acceptKey(parsed.keyB64, isVideoMediaLabel(parsed.label));
      });
    }

    const encrypted = looksEncryptedMessage(body);
    if (!(isEncryptionActive || encrypted) || !encrypted) {
      setResolved(true);
      return () => { cancelled = true; unsubscribe(); };
    }

    fallbackTimer = setTimeout(() => {
      if (cancelled) return;
      const latest = messageId ? getMediaKey(messageId) : undefined;
      if (latest) {
        acceptKey(latest.mediaKeyB64, latest.isVideo);
        return;
      }

      void resolvePlaintext({ body, messageId, decrypt })
        .then((result) => {
          if (cancelled) return;
          if (result?.mediaKeyB64) {
            acceptKey(result.mediaKeyB64, isVideoMediaLabel(result.text));
            return;
          }
          // Do not clear a key that was already displayed while this async
          // fallback was running.
          if (!mediaKeyRef.current) setResolved(true);
        })
        .catch(() => {
          if (!cancelled && !mediaKeyRef.current) setResolved(true);
        });
    }, 1_000);

    return () => {
      cancelled = true;
      unsubscribe();
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
  }, [body, cachedPlaintext, decrypt, inlineMedia, isEncryptionActive, messageId, retryTick]);

  if (!resolved && !mediaKey) {
    return (
      <div
        className="flex min-h-[96px] min-w-[180px] items-center justify-center rounded-lg bg-muted/40 animate-pulse"
        aria-label="Récupération du média"
      />
    );
  }

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
      <div className="flex items-center justify-center gap-2 p-4 rounded-lg bg-muted/50 min-h-[72px] min-w-[180px] max-w-full">
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

  return <img src={imageUrl} alt="Photo" className="max-w-full max-h-[300px] object-cover" />;
});
