import { useState, useRef } from 'react';
import { Image, Video, X, Send } from 'lucide-react';
import { useCreatePost } from '@/hooks/usePosts';
import { useProfile } from '@/hooks/useProfile';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { UserAvatar } from './UserAvatar';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/use-toast';

export function CreatePost() {
  const { user } = useAuth();
  const { data: profile } = useProfile();
  const createPost = useCreatePost();
  const [body, setBody] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [media, setMedia] = useState<File | null>(null);
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<'image' | 'video' | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
      setExpanded(true);
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
      setExpanded(false);
      
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
    <div className="premium-card p-4">
      <div className="flex gap-3 items-start">
        <UserAvatar src={profile?.avatar_url} alt={profile?.name} size="md" />
        
        <div className="flex-1 min-w-0">
          {/* Collapsed state — simple clickable input */}
          {!expanded ? (
            <button
              onClick={() => {
                setExpanded(true);
                setTimeout(() => textareaRef.current?.focus(), 100);
              }}
              className="w-full text-left px-4 py-2.5 rounded-full bg-secondary/60 hover:bg-secondary text-sm text-muted-foreground transition-colors"
            >
              Quoi de neuf, {profile?.name?.split(' ')[0] || ''} ?
            </button>
          ) : (
            <>
              <textarea
                ref={textareaRef}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Quoi de neuf ?"
                className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none min-h-[80px] leading-relaxed"
                autoFocus
              />
              
              {mediaPreview && (
                <div className="relative mt-2 rounded-xl overflow-hidden">
                  {mediaType === 'video' ? (
                    <video src={mediaPreview} controls className="w-full max-h-52 object-cover rounded-xl" />
                  ) : (
                    <img src={mediaPreview} alt="Aperçu" className="w-full max-h-52 object-cover rounded-xl" />
                  )}
                  <Button
                    variant="secondary"
                    size="icon"
                    onClick={removeMedia}
                    className="absolute top-2 right-2 h-7 w-7 rounded-full bg-background/80 backdrop-blur-sm"
                  >
                    <X className="w-3.5 h-3.5" />
                  </Button>
                </div>
              )}
              
              <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/30">
                <input type="file" ref={fileInputRef} onChange={(e) => handleFileChange(e, 'image')} accept="image/*" className="hidden" />
                <input type="file" ref={videoInputRef} onChange={(e) => handleFileChange(e, 'video')} accept="video/*" className="hidden" />
                
                <div className="flex gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => fileInputRef.current?.click()}
                    className="h-9 w-9 rounded-full text-muted-foreground hover:text-primary hover:bg-primary/10"
                  >
                    <Image className="w-[18px] h-[18px]" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => videoInputRef.current?.click()}
                    className="h-9 w-9 rounded-full text-muted-foreground hover:text-primary hover:bg-primary/10"
                  >
                    <Video className="w-[18px] h-[18px]" />
                  </Button>
                </div>
                
                <Button
                  onClick={handleSubmit}
                  disabled={(!body.trim() && !media) || isUploading}
                  size="sm"
                  className="premium-button h-9 px-5 text-xs"
                >
                  {isUploading ? (
                    <span className="animate-pulse">Publication…</span>
                  ) : (
                    <>
                      <Send className="w-3.5 h-3.5 mr-1.5" />
                      Publier
                    </>
                  )}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
      
      {/* Quick action row when collapsed */}
      {!expanded && (
        <div className="flex items-center justify-around mt-3 pt-3 border-t border-border/30">
          <input type="file" ref={fileInputRef} onChange={(e) => handleFileChange(e, 'image')} accept="image/*" className="hidden" />
          <input type="file" ref={videoInputRef} onChange={(e) => handleFileChange(e, 'video')} accept="video/*" className="hidden" />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-primary transition-colors py-1"
          >
            <Image className="w-4 h-4 text-primary/70" />
            <span>Photo</span>
          </button>
          <button
            onClick={() => videoInputRef.current?.click()}
            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-primary transition-colors py-1"
          >
            <Video className="w-4 h-4 text-destructive/70" />
            <span>Vidéo</span>
          </button>
        </div>
      )}
    </div>
  );
}
