import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';
import { uploadToR2 } from '@/lib/r2';

type MediaFolder = 'avatars' | 'images' | 'videos' | 'products' | 'stories' | 'backgrounds' | 'documents' | 'voice' | 'lives' | 'feed';

interface UseR2UploadOptions {
  folder: MediaFolder;
  onSuccess?: (url: string) => void;
  maxSizeMB?: number;
}

export function useR2Upload({ folder, onSuccess, maxSizeMB = 5 }: UseR2UploadOptions) {
  const { user } = useAuth();
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const upload = async (file: File): Promise<string | null> => {
    if (!user) {
      toast.error('Vous devez être connecté pour uploader un fichier');
      return null;
    }

    const maxSizeBytes = maxSizeMB * 1024 * 1024;
    if (file.size > maxSizeBytes) {
      toast.error(`Le fichier ne doit pas dépasser ${maxSizeMB}MB`);
      return null;
    }

    setIsUploading(true);
    setProgress(10);

    try {
      setProgress(30);
      const { url } = await uploadToR2(file, folder, undefined, (p) => {
        setProgress(Math.max(30, Math.min(99, p.percent)));
      });
      setProgress(100);

      // Silent success — no toast needed
      onSuccess?.(url);
      return url;
    } catch (error: any) {
      console.error('R2 upload failed:', error);
      toast.error(error.message || "Erreur lors de l'upload");
      return null;
    } finally {
      setIsUploading(false);
      setProgress(0);
    }
  };

  return { upload, isUploading, progress };
}
