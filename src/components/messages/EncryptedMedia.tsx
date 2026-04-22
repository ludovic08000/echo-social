/**
 * EncryptedMedia — fetches an encrypted blob from R2, decrypts it
 * client-side with the per-file AES-256-GCM key, and displays the result.
 *
 * The media key comes from the E2EE-encrypted message body (via MKEY: tag).
 */

import { useState, useEffect, useRef, memo } from 'react';
import { Lock } from 'lucide-react';
import { importMediaKey, decryptMedia } from '@/lib/crypto/mediaEncrypt';
import { fetchR2Object } from '@/lib/r2';

interface EncryptedMediaProps {
  /** URL of the encrypted blob on R2 */
  encryptedUrl: string;
  /** Base64 per-file AES-256-GCM key (from MKEY) */
  mediaKeyB64: string;
  /** Whether the original file was a video */
  isVideo?: boolean;
}

export const EncryptedMedia = memo(function EncryptedMedia({
  encryptedUrl,
  mediaKeyB64,
  isVideo = false,
}: EncryptedMediaProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const revokeRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // 1. Download the encrypted blob via authenticated proxy.
        const response = await fetchR2Object(encryptedUrl);
        const encryptedData = await response.arrayBuffer();

        if (cancelled) return;

        // 2. Decrypt
        const key = await importMediaKey(mediaKeyB64);
        const decrypted = await decryptMedia(encryptedData, key);

        if (cancelled) return;

        // 3. Create object URL for display
        const mimeType = isVideo ? 'video/mp4' : 'image/jpeg';
        const blob = new Blob([decrypted], { type: mimeType });
        const url = URL.createObjectURL(blob);

        revokeRef.current = url;
        setObjectUrl(url);
      } catch (err) {
        console.error('Media decryption failed:', err);
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (revokeRef.current) {
        URL.revokeObjectURL(revokeRef.current);
        revokeRef.current = null;
      }
    };
  }, [encryptedUrl, mediaKeyB64, isVideo]);

  if (loading) {
    return (
      <div
        className="rounded-lg bg-muted/40 animate-pulse max-w-full"
        style={{ width: 240, height: isVideo ? 180 : 200 }}
        aria-label="Chargement du média"
      />
    );
  }

  if (error || !objectUrl) {
    return (
      <div className="flex items-center justify-center gap-2 p-4 rounded-lg bg-destructive/10 min-h-[60px]">
        <Lock className="w-4 h-4 text-destructive" />
        <span className="text-xs text-destructive">Impossible de déchiffrer ce média</span>
      </div>
    );
  }

  if (isVideo) {
    return (
      <video
        src={objectUrl}
        controls
        playsInline
        className="max-w-full max-h-[300px] rounded-lg"
      />
    );
  }

  return (
    <img
      src={objectUrl}
      alt="Photo chiffrée"
      className="max-w-full max-h-[300px] object-cover rounded-lg"
    />
  );
});
