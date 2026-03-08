import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';
import { uploadToR2 } from '@/lib/r2';

type MediaFolder = 'avatars' | 'images' | 'videos' | 'products' | 'stories' | 'backgrounds' | 'documents' | 'voice' | 'lives' | 'feed';

interface UseImageUploadOptions {
  bucket: MediaFolder;
  onSuccess?: (url: string) => void;
  maxSizeMB?: number;
}

export function useImageUpload({ bucket, onSuccess, maxSizeMB = 5 }: UseImageUploadOptions) {
  const { user } = useAuth();
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const upload = async (file: File): Promise<string | null> => {
    if (!user) {
      toast.error('Vous devez être connecté pour uploader une image');
      return null;
    }

    if (!file.type.startsWith('image/')) {
      toast.error('Seules les images sont autorisées');
      return null;
    }

    const maxSizeBytes = maxSizeMB * 1024 * 1024;
    if (file.size > maxSizeBytes) {
      toast.error(`L'image ne doit pas dépasser ${maxSizeMB}MB`);
      return null;
    }

    setIsUploading(true);
    setProgress(10);

    try {
      setProgress(30);
      const { url } = await uploadToR2(file, bucket);
      setProgress(100);
      
      toast.success('Image uploadée avec succès');
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
