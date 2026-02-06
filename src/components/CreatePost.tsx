import { useState, useRef } from 'react';
import { Image, Video, X, Send } from 'lucide-react';
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
  const [media, setMedia] = useState<File | null>(null);
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<'image' | 'video' | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, type: 'image' | 'video') => {
    const file = e.target.files?.[0];
    if (file) {
      const maxSize = type === 'video' ? 50 * 1024 * 1024 : 5 * 1024 * 1024;
      if (file.size > maxSize) {
        toast({
          title: 'Fichier trop volumineux',
          description: type === 'video' ? 'Taille max : 50 Mo' : 'Taille max : 5 Mo',
          variant: 'destructive',
        });
        return;
      }
      setMedia(file);
      setMediaType(type);
      setMediaPreview(URL.createObjectURL(file));
    }
  };

  const removeMedia = () => {
    setMedia(null);
    setMediaPreview(null);
    setMediaType(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (videoInputRef.current) videoInputRef.current.value = '';
  };

  const handleSubmit = async () => {
    if (!body.trim() && !media) return;
    if (!user) return;

    setIsUploading(true);

    try {
      let imageUrl: string | undefined;

      if (media) {
        const fileExt = media.name.split('.').pop();
        const bucket = mediaType === 'video' ? 'videos' : 'post-images';
        const filePath = `${user.id}/${Date.now()}.${fileExt}`;

        const { error: uploadError } = await supabase.storage
          .from(bucket)
          .upload(filePath, media);

        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage
          .from(bucket)
          .getPublicUrl(filePath);

        imageUrl = urlData.publicUrl;
      }

      await createPost.mutateAsync({ body: body.trim(), imageUrl });
      
      setBody('');
      removeMedia();
      
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
          
          {mediaPreview && (
            <div className="relative mt-3 rounded-xl overflow-hidden">
              {mediaType === 'video' ? (
                <video
                  src={mediaPreview}
                  controls
                  className="w-full max-h-64 object-cover"
                />
              ) : (
                <img
                  src={mediaPreview}
                  alt="Aperçu"
                  className="w-full max-h-64 object-cover"
                />
              )}
              <Button
                variant="secondary"
                size="icon"
                onClick={removeMedia}
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
              onChange={(e) => handleFileChange(e, 'image')}
              accept="image/*"
              className="hidden"
            />
            <input
              type="file"
              ref={videoInputRef}
              onChange={(e) => handleFileChange(e, 'video')}
              accept="video/*"
              className="hidden"
            />
            
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                className="text-muted-foreground hover:text-primary"
              >
                <Image className="w-5 h-5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => videoInputRef.current?.click()}
                className="text-muted-foreground hover:text-primary"
              >
                <Video className="w-5 h-5" />
              </Button>
            </div>
            
            <Button
              onClick={handleSubmit}
              disabled={(!body.trim() && !media) || isUploading}
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
