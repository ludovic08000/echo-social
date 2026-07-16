/**
 * EncryptedMedia — fetches an encrypted blob from R2, decrypts it client-side,
 * and keeps the last valid object URL visible while a retry runs.
 */

import { useState, useEffect, memo, useCallback } from 'react';
import { Lock, RotateCcw } from 'lucide-react';
import { importMediaKey, decryptMediaWithMetadata } from '@/lib/crypto/mediaEncrypt';
import { fetchR2Object } from '@/lib/r2';
import { queueMediaDownload } from '@/lib/messaging/mediaDownloadQueue';
import {
  forgetDecryptedMedia,
  getDecryptedMedia,
  rememberDecryptedMedia,
  retainDecryptedMedia,
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
  const mediaCacheKey = `${encryptedUrl}\x00${mediaKeyB64}`;
  const cached = getDecryptedMedia(mediaCacheKey);
  const [objectUrl, setObjectUrl] = useState<string | null>(cached?.objectUrl ?? null);
  const [resolvedIsVideo, setResolvedIsVideo] = useState(cached?.isVideo ?? isVideo);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(!cached);
  const [retryTick, setRetryTick] = useState(0);

  const retry = useCallback(() => {
    forgetDecryptedMedia(mediaCacheKey);
    setObjectUrl(null);
    setResolvedIsVideo(isVideo);
    setErrorMessage(null);
    setLoading(true);
    setRetryTick((tick) => tick + 1);
  }, [mediaCacheKey, isVideo]);

  const handleRenderError = useCallback(() => {
    // Do not auto-loop forever. A wrong media kind/MIME used to alternate
    // between the loading skeleton and a failed <img>/<video> indefinitely.
    forgetDecryptedMedia(mediaCacheKey);
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
  }, [mediaCacheKey, resolvedIsVideo]);

  useEffect(() => subscribeDecryptedMedia(mediaCacheKey, (entry) => {
    setObjectUrl(entry.objectUrl);
    setResolvedIsVideo(entry.isVideo);
    setErrorMessage(null);
    setLoading(false);
  }), [mediaCacheKey]);

  useEffect(() => {
    if (!objectUrl) return;
    const hit = getDecryptedMedia(mediaCacheKey);
    if (!hit || hit.objectUrl !== objectUrl) return;
    return retainDecryptedMedia(mediaCacheKey);
  }, [mediaCacheKey, objectUrl]);

  useEffect(() => {
    const hit = getDecryptedMedia(mediaCacheKey);
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

    const download = async () => {
      const t0 = performance.now();
      try {
        const response = await fetchR2Object(encryptedUrl);
        if (!response.ok) throw new Error(`media_fetch_${response.status}`);
        const encryptedData = await response.arrayBuffer();

        const key = await importMediaKey(mediaKeyB64);
        const decrypted = await decryptMediaWithMetadata(encryptedData, key);

        const fallbackMime = isVideo ? 'video/mp4' : 'image/jpeg';
        const mimeType = decrypted.mimeType || fallbackMime;
        const mediaIsVideo = mimeType.startsWith('video/') || (!mimeType.startsWith('image/') && isVideo);
        const blob = new Blob([decrypted.data], { type: mimeType });
        const createdUrl = URL.createObjectURL(blob);
        // This URL is owned by the decrypted-media cache; unlike an upload
        // preview it must not be cloned or revoked by another component.
        rememberDecryptedMedia(mediaCacheKey, createdUrl, mediaIsVideo, false);

        logCryptoError({
          severity: 'info',
          context: 'media',
          errorCode: 'MEDIA_DECRYPT_OK',
          errorMessage: 'Encrypted media decrypted successfully',
          metadata: {
            isVideo: mediaIsVideo,
            mimeType,
            sizeBytes: encryptedData.byteLength,
            durationMs: Math.round(performance.now() - t0),
          },
        });
      } catch (err) {
        logCryptoException('media', err, {
          severity: 'warning',
          metadata: {
            stage: 'queued_download_attempt',
            isVideo,
            urlHost: (() => { try { return new URL(encryptedUrl).host; } catch { return 'unknown'; } })(),
            durationMs: Math.round(performance.now() - t0),
          },
        });
        throw err;
      }
    };

    void queueMediaDownload(mediaCacheKey, download, { priority: 10 })
      .then(() => {
        if (cancelled) return;
        const entry = getDecryptedMedia(mediaCacheKey);
        if (!entry) throw new Error('media_cache_missing_after_download');
        setObjectUrl(entry.objectUrl);
        setResolvedIsVideo(entry.isVideo);
        setErrorMessage(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Media recovery exhausted:', err);
        logCryptoException('media', err, {
          severity: 'error',
          metadata: {
            stage: 'queued_download_exhausted',
            isVideo,
            urlHost: (() => { try { return new URL(encryptedUrl).host; } catch { return 'unknown'; } })(),
          },
        });
        setLoading(false);
        setErrorMessage('Impossible de récupérer ce média');
      });

    return () => { cancelled = true; };
  }, [encryptedUrl, mediaKeyB64, mediaCacheKey, isVideo, retryTick]);

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