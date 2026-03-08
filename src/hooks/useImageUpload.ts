import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';

type BucketName = 'avatars' | 'post-images' | 'videos' | 'products';

interface UseImageUploadOptions {
  bucket: BucketName;
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

    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast.error('Seules les images sont autorisées');
      return null;
    }

    // Validate file size
    const maxSizeBytes = maxSizeMB * 1024 * 1024;
    if (file.size > maxSizeBytes) {
      toast.error(`L'image ne doit pas dépasser ${maxSizeMB}MB`);
      return null;
    }

    setIsUploading(true);
    setProgress(10);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('folder', bucket);

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

      setProgress(70);

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Upload failed');
      }

      const result = await response.json();
      setProgress(100);
      
      toast.success('Image uploadée avec succès');
      onSuccess?.(result.url);
      
      return result.url;
    } catch (error: any) {
      console.error('Upload failed:', error);
      toast.error(error.message || "Erreur lors de l'upload");
      return null;
    } finally {
      setIsUploading(false);
      setProgress(0);
    }
  };

  return {
    upload,
    isUploading,
    progress,
  };
}
