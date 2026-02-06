import { useState, useRef } from 'react';
import { Image, Video, X, Send, Timer, Rocket } from 'lucide-react';
import { useCreatePost } from '@/hooks/usePosts';
import { useProfile } from '@/hooks/useProfile';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { UserAvatar } from './UserAvatar';
import { MoodPicker } from './MoodPicker';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

const EXPIRY_OPTIONS = [
  { label: '1h', value: 1, description: '1 heure' },
  { label: '6h', value: 6, description: '6 heures' },
  { label: '24h', value: 24, description: '24 heures' },
];

const CAPSULE_OPTIONS = [
  { label: '1 semaine', value: 7 },
  { label: '1 mois', value: 30 },
  { label: '3 mois', value: 90 },
  { label: '6 mois', value: 180 },
  { label: '1 an', value: 365 },
];

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
  const [expiryHours, setExpiryHours] = useState<number | null>(null);
  const [capsuleDays, setCapsuleDays] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Capsule and ephemeral are mutually exclusive
  const handleSetExpiry = (h: number) => { setExpiryHours(h); setCapsuleDays(null); };
  const handleSetCapsule = (d: number) => { setCapsuleDays(d); setExpiryHours(null); };

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

      // Calculate expires_at if ephemeral
      let expiresAt: string | undefined;
      if (expiryHours) {
        const date = new Date();
        date.setHours(date.getHours() + expiryHours);
        expiresAt = date.toISOString();
      }

      // Calculate publish_at if capsule temporelle
      let publishAt: string | undefined;
      if (capsuleDays) {
        const date = new Date();
        date.setDate(date.getDate() + capsuleDays);
        publishAt = date.toISOString();
      }

      await createPost.mutateAsync({ body: body.trim(), imageUrl, expiresAt, publishAt });
      
      setBody('');
      removeMedia();
      setExpanded(false);
      setExpiryHours(null);
      setCapsuleDays(null);
      
      toast({
        title: capsuleDays 
          ? `🚀 Capsule temporelle programmée !`
          : expiryHours 
            ? `⏳ Post éphémère publié (${expiryHours}h)` 
            : 'Post publié !',
        description: capsuleDays
          ? `Ce post apparaîtra dans ${capsuleDays} jours`
          : expiryHours 
            ? `Ce post disparaîtra dans ${expiryHours} heure${expiryHours > 1 ? 's' : ''}`
            : 'Votre post a été partagé avec succès',
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
        <UserAvatar 
          src={profile?.avatar_url} 
          alt={profile?.name} 
          size="md" 
          moodEmoji={(profile as any)?.mood_emoji}
        />
        
        <div className="flex-1 min-w-0">
          {/* Mood picker + Name */}
          <div className="flex items-center gap-2 mb-2">
            <MoodPicker />
          </div>

          {/* Collapsed state */}
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

              {/* Ephemeral badge */}
              {expiryHours && (
                <div className="flex items-center gap-1.5 mb-2">
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[11px] font-medium border border-amber-500/20">
                    <Timer className="w-3 h-3" />
                    Post éphémère · {expiryHours}h
                    <button onClick={() => setExpiryHours(null)} className="ml-1 hover:text-foreground">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                </div>
              )}

              {/* Capsule badge */}
              {capsuleDays && (
                <div className="flex items-center gap-1.5 mb-2">
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-violet-500/15 text-violet-600 dark:text-violet-400 text-[11px] font-medium border border-violet-500/20">
                    <Rocket className="w-3 h-3" />
                    Capsule · dans {capsuleDays}j
                    <button onClick={() => setCapsuleDays(null)} className="ml-1 hover:text-foreground">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                </div>
              )}
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
                  
                  {/* Ephemeral post timer */}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                          "h-9 w-9 rounded-full",
                          expiryHours 
                            ? "text-amber-500 bg-amber-500/10" 
                            : "text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10"
                        )}
                      >
                        <Timer className="w-[18px] h-[18px]" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-48 p-2 rounded-xl">
                      <p className="text-xs font-semibold mb-2 px-2">Post éphémère ⏳</p>
                      {EXPIRY_OPTIONS.map(opt => (
                        <button
                          key={opt.value}
                          onClick={() => setExpiryHours(opt.value)}
                          className={cn(
                            "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors",
                            expiryHours === opt.value 
                              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium" 
                              : "hover:bg-secondary/60 text-foreground"
                          )}
                        >
                          {opt.description}
                        </button>
                      ))}
                      {expiryHours && (
                        <button
                          onClick={() => setExpiryHours(null)}
                          className="w-full text-left px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-secondary/60"
                        >
                          Annuler le minuteur
                        </button>
                      )}
                    </PopoverContent>
                  </Popover>

                  {/* Capsule temporelle */}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                          "h-9 w-9 rounded-full",
                          capsuleDays 
                            ? "text-violet-500 bg-violet-500/10" 
                            : "text-muted-foreground hover:text-violet-500 hover:bg-violet-500/10"
                        )}
                      >
                        <Rocket className="w-[18px] h-[18px]" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-48 p-2 rounded-xl">
                      <p className="text-xs font-semibold mb-2 px-2">Capsule temporelle 🚀</p>
                      {CAPSULE_OPTIONS.map(opt => (
                        <button
                          key={opt.value}
                          onClick={() => handleSetCapsule(opt.value)}
                          className={cn(
                            "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors",
                            capsuleDays === opt.value 
                              ? "bg-violet-500/15 text-violet-600 dark:text-violet-400 font-medium" 
                              : "hover:bg-secondary/60 text-foreground"
                          )}
                        >
                          {opt.label}
                        </button>
                      ))}
                      {capsuleDays && (
                        <button
                          onClick={() => setCapsuleDays(null)}
                          className="w-full text-left px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-secondary/60"
                        >
                          Annuler la capsule
                        </button>
                      )}
                    </PopoverContent>
                  </Popover>
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
          <button
            onClick={() => {
              setExpanded(true);
              setExpiryHours(1);
            }}
            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-amber-500 transition-colors py-1"
          >
            <Timer className="w-4 h-4 text-amber-500/70" />
            <span>Éphémère</span>
          </button>
        </div>
      )}
    </div>
  );
}
