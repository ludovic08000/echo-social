import { useState, useRef } from 'react';
import { Image, X, Send } from 'lucide-react';
import { useCreatePost } from '@/hooks/usePosts';
import { useProfile } from '@/hooks/useProfile';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { UserAvatar } from './UserAvatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';

export function CreatePost() {
  const { user } = useAuth();
  const { data: profile } = useProfile();
  const createPost = useCreatePost();
  const [body, setBody] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        toast({
          title: 'Image trop volumineuse',
          description: 'La taille maximale est de 5 Mo',
          variant: 'destructive',
        });
        return;
      }
      setImage(file);
      setImagePreview(URL.createObjectURL(file));
    }
  };

  const removeImage = () => {
    setImage(null);
    setImagePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleSubmit = async () => {
    if (!body.trim() && !image) return;
    if (!user) return;

    setIsUploading(true);

    try {
      let imageUrl: string | undefined;

      if (image) {
        const fileExt = image.name.split('.').pop();
        const filePath = `${user.id}/${Date.now()}.${fileExt}`;

        const { error: uploadError } = await supabase.storage
          .from('post-images')
          .upload(filePath, image);

        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage
          .from('post-images')
          .getPublicUrl(filePath);

        imageUrl = urlData.publicUrl;
      }

      await createPost.mutateAsync({ body: body.trim(), imageUrl });
      
      setBody('');
      removeImage();
      
      toast({
        title: 'Post publié !',
        description: 'Votre post a été partagé avec succès',
      });
    } catch (error) {
      toast({
        title: 'Erreur',
        description: 'Impossible de publier le post',
        variant: 'destructive',
      });
    } finally {
      setIsUploading(false);
    }
  };

  if (!user) return null;

  return (
    <div className="pulse-card p-4 sm:p-5">
      <div className="flex gap-3">
        <UserAvatar src={profile?.avatar_url} alt={profile?.name} size="md" />
        
        <div className="flex-1">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Quoi de neuf ?"
            className="pulse-input min-h-[80px] resize-none border-0 p-0 text-base focus:ring-0"
          />
          
          {imagePreview && (
            <div className="relative mt-3 rounded-xl overflow-hidden">
              <img
                src={imagePreview}
                alt="Aperçu"
                className="w-full max-h-64 object-cover"
              />
              <Button
                variant="secondary"
                size="icon"
                onClick={removeImage}
                className="absolute top-2 right-2 h-8 w-8 rounded-full bg-background/80 backdrop-blur-sm"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          )}
          
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/50">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImageChange}
              accept="image/*"
              className="hidden"
            />
            
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="text-muted-foreground hover:text-primary"
            >
              <Image className="w-5 h-5" />
            </Button>
            
            <Button
              onClick={handleSubmit}
              disabled={(!body.trim() && !image) || isUploading}
              className="pulse-button-gradient h-9 px-4"
            >
              {isUploading ? (
                <span className="animate-pulse">Publication...</span>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-2" />
                  Publier
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
