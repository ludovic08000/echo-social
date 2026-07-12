/**
 * EncryptedMedia — fetches an encrypted blob from R2, decrypts it client-side,
 * and keeps the last valid object URL visible while a retry runs.
 */

import { useState, useEffect, memo } from 'react';
import { Lock } from 'lucide-react';
import { importMediaKey, decryptMedia } from '@/lib/crypto/mediaEncrypt';
import { fetchR2Object } from '@/lib/r2';
import {
  getDecryptedMedia,
  rememberDecryptedMedia,
  retainDecryptedMedia,
  releaseDecryptedMedia,
} from './decryptedMediaCache';
import { logCryptoException, logCryptoError } from '@/lib/crypto/errorLogger';

interface EncryptedMediaProps {
  encryptedUrl: string;
  mediaKeyB64: string;
  isVideo?: boolean;
}

export const EncryptedMedia = memo(function EncryptedMedia({
  encryptedUrl,
  mediaKeyB64,
  isVideo = false,
}: EncryptedMediaProps) {
  const cached = getDecryptedMedia(encryptedUrl);
  const [objectUrl, setObjectUrl] = useState<string | null>(cached?.objectUrl ?? null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    if (!objectUrl) return;
    const hit = getDecryptedMedia(encryptedUrl);
    if (!hit || hit.objectUrl !== objectUrl) return;
    retainDecryptedMedia(encryptedUrl);
    return () => releaseDecryptedMedia(encryptedUrl);
  }, [encryptedUrl, objectUrl]);

  useEffect(() => {
    const hit = getDecryptedMedia(encryptedUrl);
    if (hit) {
      setObjectUrl(hit.objectUrl);
      setError(false);
      setLoading(false);
      return;
    }

    let cancelled = false;
    // Preserve a previously valid URL while refreshing. Only show a skeleton
    // when this component has never rendered valid media.
    setError(false);
    setLoading((current) => objectUrl ? false : current || true);

    (async () => {
      const t0 = performance.now();
      try {
        const response = await fetchR2Object(encryptedUrl);
        if (!response.ok) throw new Error(`media_fetch_${response.status}`);
        const encryptedData = await response.arrayBuffer();
        if (cancelled) return;

        const key = await importMediaKey(mediaKeyB64);
        const decrypted = await decryptMedia(encryptedData, key);
        if (cancelled) return;

        const mimeType = isVideo ? 'video/mp4' : 'image/jpeg';
        const blob = new Blob([decrypted], { type: mimeType });
        const createdUrl = URL.createObjectURL(blob);
        rememberDecryptedMedia(encryptedUrl, createdUrl, isVideo);
        const canonical = getDecryptedMedia(encryptedUrl)?.objectUrl ?? createdUrl;

        setObjectUrl(canonical);
        setError(false);
        setLoading(false);
        logCryptoError({
          severity: 'info',
          context: 'media',
          errorCode: 'MEDIA_DECRYPT_OK',
          errorMessage: 'Encrypted media decrypted successfully',
          metadata: {
            isVideo,
            sizeBytes: encryptedData.byteLength,
            durationMs: Math.round(performance.now() - t0),
          },
        });
      } catch (err) {
        console.error('Media decryption failed:', err);
        logCryptoException('media', err, {
          severity: 'error',
          metadata: {
            stage: 'decrypt',
            isVideo,
            urlHost: (() => { try { return new URL(encryptedUrl).host; } catch { return 'unknown'; } })(),
            durationMs: Math.round(performance.now() - t0),
          },
        });
        if (!cancelled && !objectUrl) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [encryptedUrl, mediaKeyB64, isVideo]);

  if (loading && !objectUrl) {
    return (
      <div
        className="rounded-lg bg-muted/40 animate-pulse max-w-full"
        style={{ width: 240, height: isVideo ? 180 : 200 }}
        aria-label="Chargement du média"
      />
    );
  }

  if (!objectUrl) {
    return (
      <div className="flex items-center justify-center gap-2 p-4 rounded-lg bg-destructive/10 min-h-[60px]">
        <Lock className="w-4 h-4 text-destructive" />
        <span className="text-xs text-destructive">
          {error ? 'Impossible de déchiffrer ce média' : 'Média en cours de récupération'}
        </span>
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
