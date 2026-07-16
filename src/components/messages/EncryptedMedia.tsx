/**
 * EncryptedMedia — fetches an encrypted blob from R2, decrypts it client-side,
 * and keeps the last valid object URL visible while a retry runs.
 */

import { useState, useEffect, memo, useCallback } from 'react';
import { Lock, RotateCcw } from 'lucide-react';
import { importMediaKey, decryptMediaWithMetadata } from '@/lib/crypto/mediaEncrypt';
import { fetchR2Object } from '@/lib/r2';
import {
  forgetDecryptedMedia,
  getDecryptedMedia,
  rememberDecryptedMedia,
  retainDecryptedMedia,
  releaseDecryptedMedia,
  subscribeDecryptedMedia,
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
  const [resolvedIsVideo, setResolvedIsVideo] = useState(cached?.isVideo ?? isVideo);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(!cached);
  const [retryTick, setRetryTick] = useState(0);

  const retry = useCallback(() => {
    forgetDecryptedMedia(encryptedUrl);
    setObjectUrl(null);
    setResolvedIsVideo(isVideo);
    setErrorMessage(null);
    setLoading(true);
    setRetryTick((tick) => tick + 1);
  }, [encryptedUrl, isVideo]);

  const handleRenderError = useCallback(() => {
    // Do not auto-loop forever. A wrong media kind/MIME used to alternate
    // between the loading skeleton and a failed <img>/<video> indefinitely.
    forgetDecryptedMedia(encryptedUrl);
    setObjectUrl(null);
    setLoading(false);
    setErrorMessage('Format du média non pris en charge');
    logCryptoError({
      severity: 'error',
      context: 'media',
      errorCode: 'MEDIA_RENDER_FAILED',
      errorMessage: 'Browser failed to decode decrypted media',
      metadata: { isVideo: resolvedIsVideo },
    });
  }, [encryptedUrl, resolvedIsVideo]);

  useEffect(() => subscribeDecryptedMedia(encryptedUrl, (entry) => {
    setObjectUrl(entry.objectUrl);
    setResolvedIsVideo(entry.isVideo);
    setErrorMessage(null);
    setLoading(false);
  }), [encryptedUrl]);

  useEffect(() => {
    const onOnline = () => {
      if (errorMessage || !objectUrl) retry();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [errorMessage, objectUrl, retry]);

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
      setResolvedIsVideo(hit.isVideo);
      setErrorMessage(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setErrorMessage(null);
    setLoading(true);

    (async () => {
      const t0 = performance.now();
      try {
        const response = await fetchR2Object(encryptedUrl);
        if (!response.ok) throw new Error(`media_fetch_${response.status}`);
        const encryptedData = await response.arrayBuffer();
        if (cancelled) return;

        const key = await importMediaKey(mediaKeyB64);
        const decrypted = await decryptMediaWithMetadata(encryptedData, key);
        if (cancelled) return;

        const fallbackMime = isVideo ? 'video/mp4' : 'image/jpeg';
        const mimeType = decrypted.mimeType || fallbackMime;
        const mediaIsVideo = mimeType.startsWith('video/') || (!mimeType.startsWith('image/') && isVideo);
        const blob = new Blob([decrypted.data], { type: mimeType });
        const createdUrl = URL.createObjectURL(blob);
        // This URL is owned by the decrypted-media cache; unlike an upload
        // preview it must not be cloned or revoked by another component.
        rememberDecryptedMedia(encryptedUrl, createdUrl, mediaIsVideo, false);
        const canonicalEntry = getDecryptedMedia(encryptedUrl);
        const canonical = canonicalEntry?.objectUrl ?? createdUrl;
        const canonicalIsVideo = canonicalEntry?.isVideo ?? mediaIsVideo;

        setObjectUrl(canonical);
        setResolvedIsVideo(canonicalIsVideo);
        setErrorMessage(null);
        setLoading(false);
        logCryptoError({
          severity: 'info',
          context: 'media',
          errorCode: 'MEDIA_DECRYPT_OK',
          errorMessage: 'Encrypted media decrypted successfully',
          metadata: {
            isVideo: canonicalIsVideo,
            mimeType,
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
        if (!cancelled) setErrorMessage('Impossible de déchiffrer ce média');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [encryptedUrl, mediaKeyB64, isVideo, retryTick]);

  if (loading && !objectUrl) {
    return (
      <div
        className="rounded-lg bg-muted/40 animate-pulse max-w-full"
        style={{ width: 240, height: resolvedIsVideo ? 180 : 200 }}
        aria-label="Chargement du média"
      />
    );
  }

  if (!objectUrl) {
    return (
      <div className="flex min-h-[72px] min-w-[180px] flex-col items-center justify-center gap-2 rounded-lg bg-destructive/10 p-4">
        <div className="flex items-center gap-2">
          <Lock className="w-4 h-4 text-destructive" />
          <span className="text-xs text-destructive">
            {errorMessage || 'Média en cours de récupération'}
          </span>
        </div>
        {errorMessage && (
          <button
            type="button"
            onClick={retry}
            className="inline-flex items-center gap-1 text-xs underline underline-offset-2"
          >
            <RotateCcw className="h-3 w-3" />
            Réessayer
          </button>
        )}
      </div>
    );
  }

  if (resolvedIsVideo) {
    return (
      <video
        src={objectUrl}
        controls
        playsInline
        onError={handleRenderError}
        className="max-w-full max-h-[300px] rounded-lg"
      />
    );
  }

  return (
    <img
      src={objectUrl}
      alt="Photo chiffrée"
      onError={handleRenderError}
      className="max-w-full max-h-[300px] object-cover rounded-lg"
    />
  );
});
