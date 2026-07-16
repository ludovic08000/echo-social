import { useCallback, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';
import { uploadToR2 } from '@/lib/r2';
import {
  MAX_OUTGOING_ATTACHMENT_CIPHERTEXT_BYTES,
  MEBIBYTE,
  formatAttachmentLimit,
} from '@/lib/messaging/attachmentLimits';

type MediaFolder = 'avatars' | 'images' | 'videos' | 'products' | 'stories' | 'backgrounds' | 'documents' | 'voice' | 'lives' | 'feed' | 'post-images' | 'uploads';

const FOLDER_ALLOWED_TYPES: Record<string, string[]> = {
  avatars: ['image/'],
  images: ['image/'],
  'post-images': ['image/', 'video/', 'application/octet-stream'],
  videos: ['video/', 'image/', 'application/octet-stream'],
  products: ['image/'],
  stories: ['image/', 'video/', 'application/octet-stream'],
  backgrounds: ['image/'],
  documents: ['image/', 'application/pdf'],
  voice: ['audio/', 'application/octet-stream'],
  lives: ['image/'],
  feed: ['image/', 'video/', 'application/octet-stream'],
  uploads: ['image/', 'video/', 'application/octet-stream'],
};

const FOLDER_MAX_SIZE_BYTES: Record<string, number> = {
  avatars: 5 * MEBIBYTE,
  images: 10 * MEBIBYTE,
  // Private chat photos, videos and documents are encrypted before upload.
  'post-images': MAX_OUTGOING_ATTACHMENT_CIPHERTEXT_BYTES,
  videos: 50 * MEBIBYTE,
  products: 5 * MEBIBYTE,
  stories: 10 * MEBIBYTE,
  backgrounds: 5 * MEBIBYTE,
  documents: 10 * MEBIBYTE,
  voice: MAX_OUTGOING_ATTACHMENT_CIPHERTEXT_BYTES,
  lives: 5 * MEBIBYTE,
  feed: 50 * MEBIBYTE,
  uploads: 50 * MEBIBYTE,
};

interface UseImageUploadOptions {
  bucket: MediaFolder;
  onSuccess?: (url: string) => void;
  /** Legacy override kept for existing callers. */
  maxSizeMB?: number;
  /** Exact byte override for encrypted formats where cryptographic overhead matters. */
  maxSizeBytes?: number;
}

export interface UploadInvocationOptions {
  /** Per-file progress. Useful when several chat attachments upload concurrently. */
  onProgress?: (percent: number) => void;
}

export function useImageUpload({
  bucket,
  onSuccess,
  maxSizeMB,
  maxSizeBytes,
}: UseImageUploadOptions) {
  const { user } = useAuth();
  const [activeUploads, setActiveUploads] = useState(0);
  const [progress, setProgress] = useState(0);

  const upload = useCallback(async (
    file: File,
    invocation: UploadInvocationOptions = {},
  ): Promise<string | null> => {
    if (!user) {
      toast.error('Vous devez être connecté pour uploader un fichier');
      return null;
    }

    const allowedPrefixes = FOLDER_ALLOWED_TYPES[bucket] || ['image/', 'video/'];
    const isEncryptedMedia = file.type === 'application/octet-stream' && /\.enc(?:\.|$)/i.test(file.name);
    const isAllowed = isEncryptedMedia || allowedPrefixes.some(prefix => file.type.startsWith(prefix) || file.type === prefix);
    if (!isAllowed) {
      const label = allowedPrefixes.map(p => p.replace('/', '')).join(', ');
      toast.error(`Type de fichier non autorisé. Accepté : ${label}`);
      return null;
    }

    const effectiveMaxBytes = maxSizeBytes
      ?? (maxSizeMB !== undefined ? maxSizeMB * MEBIBYTE : undefined)
      ?? FOLDER_MAX_SIZE_BYTES[bucket]
      ?? 10 * MEBIBYTE;
    if (file.size > effectiveMaxBytes) {
      toast.error(`Le fichier ne doit pas dépasser ${formatAttachmentLimit(effectiveMaxBytes)}`);
      return null;
    }

    const reportProgress = (percent: number) => {
      const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
      setProgress(safePercent);
      invocation.onProgress?.(safePercent);
    };

    setActiveUploads(count => count + 1);
    reportProgress(0);

    try {
      const { url } = await uploadToR2(file, bucket, undefined, event => {
        reportProgress(event.percent);
      });
      reportProgress(100);
      onSuccess?.(url);
      return url;
    } catch (error: unknown) {
      console.error('Upload failed:', error);
      toast.error(error instanceof Error ? error.message : "Erreur lors de l'upload");
      return null;
    } finally {
      setActiveUploads(count => Math.max(0, count - 1));
    }
  }, [bucket, maxSizeBytes, maxSizeMB, onSuccess, user]);

  const hasActiveUploads = activeUploads > 0;

  return {
    upload,
    // Chat attachments already have optimistic bubbles. Keeping this false for
    // post-images prevents the camera button from looking frozen during a PUT.
    isUploading: bucket === 'post-images' ? false : hasActiveUploads,
    hasActiveUploads,
    progress,
  };
}
