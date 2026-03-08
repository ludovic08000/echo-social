import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';
import { uploadToR2 } from '@/lib/r2';

type MediaFolder = 'avatars' | 'images' | 'videos' | 'products' | 'stories' | 'backgrounds' | 'documents' | 'voice' | 'lives' | 'feed' | 'post-images' | 'uploads';

const FOLDER_ALLOWED_TYPES: Record<string, string[]> = {
  avatars: ['image/'],
  images: ['image/'],
  'post-images': ['image/', 'video/'],
  videos: ['video/', 'image/'],
  products: ['image/'],
  stories: ['image/', 'video/'],
  backgrounds: ['image/'],
  documents: ['image/', 'application/pdf'],
  voice: ['audio/'],
  lives: ['image/'],
  feed: ['image/', 'video/'],
  uploads: ['image/', 'video/'],
};

const FOLDER_MAX_SIZE_MB: Record<string, number> = {
  avatars: 5,
  images: 10,
  'post-images': 50,
  videos: 50,
  products: 5,
  stories: 10,
  backgrounds: 5,
  documents: 10,
  voice: 5,
  lives: 5,
  feed: 50,
  uploads: 50,
};

interface UseImageUploadOptions {
  bucket: MediaFolder;
  onSuccess?: (url: string) => void;
  maxSizeMB?: number;
}

export function useImageUpload({ bucket, onSuccess, maxSizeMB }: UseImageUploadOptions) {
  const { user } = useAuth();
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const upload = async (file: File): Promise<string | null> => {
    if (!user) {
      toast.error('Vous devez être connecté pour uploader un fichier');
      return null;
    }

    // Validate file type against folder
    const allowedPrefixes = FOLDER_ALLOWED_TYPES[bucket] || ['image/', 'video/'];
    const isAllowed = allowedPrefixes.some(prefix => file.type.startsWith(prefix) || file.type === prefix);
    if (!isAllowed) {
      const label = allowedPrefixes.map(p => p.replace('/', '')).join(', ');
      toast.error(`Type de fichier non autorisé. Accepté : ${label}`);
      return null;
    }

    const effectiveMaxMB = maxSizeMB ?? FOLDER_MAX_SIZE_MB[bucket] ?? 10;
    const maxSizeBytes = effectiveMaxMB * 1024 * 1024;
    if (file.size > maxSizeBytes) {
      toast.error(`Le fichier ne doit pas dépasser ${effectiveMaxMB} Mo`);
      return null;
    }

    setIsUploading(true);
    setProgress(10);

    try {
      setProgress(30);
      const { url } = await uploadToR2(file, bucket);
      setProgress(100);

      const isVideo = file.type.startsWith('video/');
      toast.success(isVideo ? 'Vidéo uploadée avec succès' : 'Fichier uploadé avec succès');
      onSuccess?.(url);
      return url;
    } catch (error: any) {
      console.error('Upload failed:', error);
      toast.error(error.message || "Erreur lors de l'upload");
      return null;
    } finally {
      setIsUploading(false);
      setProgress(0);
    }
  };

  return { upload, isUploading, progress };
}
