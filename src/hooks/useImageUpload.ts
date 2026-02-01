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
    setProgress(0);

    try {
      const fileExt = file.name.split('.').pop()?.toLowerCase() || 'jpg';
      const fileName = `${Date.now()}.${fileExt}`;
      const filePath = `${user.id}/${fileName}`;

      setProgress(30);

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(filePath, file, {
          cacheControl: '3600',
          upsert: true,
        });

      if (uploadError) {
        console.error('Upload error:', uploadError);
        throw uploadError;
      }

      setProgress(70);

      const { data: urlData } = supabase.storage
        .from(bucket)
        .getPublicUrl(filePath);

      const publicUrl = urlData.publicUrl;

      setProgress(100);
      
      toast.success('Image uploadée avec succès');
      onSuccess?.(publicUrl);
      
      return publicUrl;
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
