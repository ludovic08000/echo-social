/**
 * MessageMedia — renders media attached to a message.
 * 
 * For encrypted conversations, it decrypts the message body independently
 * to extract the MKEY, then delegates to EncryptedMedia.
 * This avoids a timing dependency on the decryptedCache.
 */

import { useState, useEffect, memo } from 'react';
import { EncryptedMedia } from './EncryptedMedia';
import { parseMediaMessage } from '@/lib/crypto/mediaEncrypt';
import { isEncryptedMessage } from '@/lib/crypto/e2ee';

interface MessageMediaProps {
  imageUrl: string;
  body: string;
  decrypt: (body: string) => Promise<{ text: string; encrypted: boolean; verified: boolean }>;
  isEncryptionActive: boolean;
}

export const MessageMedia = memo(function MessageMedia({
  imageUrl,
  body,
  decrypt,
  isEncryptionActive,
}: MessageMediaProps) {
  const [mediaKey, setMediaKey] = useState<string | null>(null);
  const [isVideo, setIsVideo] = useState(false);
  const [resolved, setResolved] = useState(!isEncryptionActive);

  useEffect(() => {
    if (!isEncryptionActive) {
      setResolved(true);
      return;
    }

    const looksEncrypted = isEncryptedMessage(body);
    if (!looksEncrypted) {
      setResolved(true);
      return;
    }

    let cancelled = false;
    decrypt(body).then(result => {
      if (cancelled) return;
      const parsed = parseMediaMessage(result.text);
      if (parsed) {
        setMediaKey(parsed.keyB64);
        setIsVideo(parsed.label.startsWith('🎬'));
      }
      setResolved(true);
    }).catch(() => {
      if (!cancelled) setResolved(true);
    });

    return () => { cancelled = true; };
  }, [body, decrypt, isEncryptionActive]);

  // Still resolving — show nothing (DecryptedMessageBody handles the spinner)
  if (!resolved) return null;

  // Encrypted media with key
  if (mediaKey) {
    return (
      <EncryptedMedia
        encryptedUrl={imageUrl}
        mediaKeyB64={mediaKey}
        isVideo={isVideo}
      />
    );
  }

  // Plain media (legacy or non-encrypted conversation)
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
