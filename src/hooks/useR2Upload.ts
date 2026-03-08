import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';

type MediaFolder = 'avatars' | 'post-images' | 'videos' | 'products';

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
      const formData = new FormData();
      formData.append('file', file);
      formData.append('folder', folder);

      setProgress(30);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('No session');

      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const response = await fetch(
        `https://${projectId}.supabase.co/functions/v1/r2-upload`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
          body: formData,
        }
      );

      setProgress(80);

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Upload failed');
      }

      const result = await response.json();
      setProgress(100);

      toast.success('Fichier uploadé avec succès');
      onSuccess?.(result.url);
      return result.url;
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
