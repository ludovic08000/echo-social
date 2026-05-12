import { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Image, Video, X, Send, Timer, Rocket, ShoppingBag, Sparkles, Loader2, Check, Globe, Type, ArrowDownRight, ArrowUpRight, Briefcase, SmilePlus, Radio, User } from 'lucide-react';
import { useCreatePost } from '@/hooks/usePosts';
import { usePostModeration } from '@/hooks/useZeusCompanion';
import { useProfile } from '@/hooks/useProfile';
import { useAuth } from '@/lib/auth';
import { uploadToR2 } from '@/lib/r2';
import { useAgeVerification } from '@/hooks/useAgeVerification';
import { generateVideoThumbnail } from '@/lib/videoThumbnail';
import { isVideoCompatible } from '@/lib/videoCompat';
import { supabase } from '@/integrations/supabase/client';
import { useNavigate } from 'react-router-dom';
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

const LANG_LABELS: Record<string, string> = {
  fr: 'Français', en: 'English', es: 'Español', de: 'Deutsch', it: 'Italiano', pt: 'Português', nl: 'Nederlands', pl: 'Polski', ar: 'العربية',
};

const CAPSULE_OPTIONS = [
  { label: '1 semaine', value: 7 },
  { label: '1 mois', value: 30 },
  { label: '3 mois', value: 90 },
  { label: '6 mois', value: 180 },
  { label: '1 an', value: 365 },
];

export function CreatePost() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: profile } = useProfile();
  const { verifyAge } = useAgeVerification();
  const createPost = useCreatePost();
  const postModeration = usePostModeration();
  const [body, setBody] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [media, setMedia] = useState<File | null>(null);
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<'image' | 'video' | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStep, setUploadStep] = useState<string | null>(null);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [expiryHours, setExpiryHours] = useState<number | null>(null);
  const [capsuleDays, setCapsuleDays] = useState<number | null>(null);
  const [publishAsReplay, setPublishAsReplay] = useState(false);
  const [replayTitle, setReplayTitle] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<{ improved_text: string; detected_language: string; corrections: string[]; tone: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Guest mode: show a teaser that redirects to signup
  if (!user) {
    return (
      <div
        onClick={() => navigate('/signup')}
        className="mx-4 p-4 rounded-2xl border border-border/40 bg-card/80 backdrop-blur-sm cursor-pointer hover:border-primary/30 hover:shadow-md transition-all duration-200 active:scale-[0.98]"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
            <User className="w-5 h-5 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground flex-1">Quoi de neuf ? Inscrivez-vous pour publier…</p>
          <Send className="w-4 h-4 text-primary" />
        </div>
      </div>
    );
  }

  const AI_ACTIONS = [
    { action: 'improve', label: 'Améliorer', icon: Sparkles, desc: 'Corrige & améliore' },
    { action: 'formal', label: 'Formel', icon: Briefcase, desc: 'Plus professionnel' },
    { action: 'casual', label: 'Décontracté', icon: SmilePlus, desc: 'Plus amical' },
    { action: 'shorter', label: 'Raccourcir', icon: ArrowDownRight, desc: 'Plus court' },
    { action: 'longer', label: 'Développer', icon: ArrowUpRight, desc: 'Plus détaillé' },
  ];

  const handleAiImprove = async (action = 'improve') => {
    if (!body.trim()) return;
    setAiLoading(true);
    setAiResult(null);
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const { data, error } = await supabase.functions.invoke('zeus', {
          body: { domain: 'post', text: body, action },
        });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        setAiResult(data);
        setAiLoading(false);
        return;
      } catch (e: any) {
        const isNetworkError = e.message?.includes('fetch') || e.message?.includes('Failed') || e.message?.includes('NetworkError');
        if (isNetworkError && attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        toast({ title: 'Erreur IA', description: isNetworkError ? 'Erreur réseau. Réessayez.' : (e.message || 'Impossible d\'améliorer le texte'), variant: 'destructive' });
      }
    }
    setAiLoading(false);
  };

  const applyAiResult = () => {
    if (aiResult) {
      setBody(aiResult.improved_text);
      setAiResult(null);
      toast({ title: '✨ Texte amélioré', description: `Langue détectée : ${LANG_LABELS[aiResult.detected_language] || aiResult.detected_language}` });
    }
  };

  const handleSetExpiry = (h: number) => { setExpiryHours(h); setCapsuleDays(null); };
  const handleSetCapsule = (d: number) => { setCapsuleDays(d); setExpiryHours(null); };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, type: 'image' | 'video') => {
    const file = e.target.files?.[0];
    if (file) {
      const maxSize = type === 'video' ? 200 * 1024 * 1024 : 5 * 1024 * 1024;
      if (file.size > maxSize) {
        toast({
          title: 'Fichier trop volumineux',
          description: type === 'video' ? 'Taille max : 200 Mo' : 'Taille max : 5 Mo',
          variant: 'destructive',
        });
        return;
      }

      // Validate video codec compatibility (iOS rejects WebM/VP9)
      if (type === 'video') {
        const compat = isVideoCompatible(file);
        if (!compat.ok) {
          toast({
            title: 'Format vidéo incompatible',
            description: compat.reason,
            variant: 'destructive',
          });
          return;
        }
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
    setPublishAsReplay(false);
    setReplayTitle('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (videoInputRef.current) videoInputRef.current.value = '';
  };

  const handleSubmit = async () => {
    if (!body.trim() && !media) return;
    if (!user) return;

    setIsUploading(true);

    try {
      let imageUrl: string | undefined;
      let thumbnailUrl: string | null = null;

      if (media) {
        if (mediaType === 'video') {
          setUploadStep('Envoi de la vidéo…');
          setUploadPercent(0);

          // Throttle progress updates to max 4/sec to avoid feed re-renders
          let lastProgressUpdate = 0;
          const throttledProgress = (p: { percent: number }) => {
            const now = Date.now();
            if (now - lastProgressUpdate > 250 || p.percent === 100) {
              lastProgressUpdate = now;
              setUploadPercent(p.percent);
              setUploadStep(`Envoi de la vidéo… ${p.percent}%`);
            }
          };

          // Run upload and thumbnail generation concurrently
          // Thumbnail uses requestIdleCallback to avoid blocking
          const [videoResult, thumbBlob] = await Promise.all([
            uploadToR2(media, 'videos', undefined, throttledProgress),
            new Promise<Blob | null>((resolve) => {
              const doThumb = () => generateVideoThumbnail(media).catch(() => null).then(resolve);
              if ('requestIdleCallback' in window) {
                requestIdleCallback(() => doThumb());
              } else {
                setTimeout(doThumb, 0);
              }
            }),
          ]);
          imageUrl = videoResult.url;

          if (thumbBlob) {
            setUploadStep('Miniature…');
            try {
              const thumbFile = new File([thumbBlob], 'thumbnail.jpg', { type: 'image/jpeg' });
              const { url: thumbUrl } = await uploadToR2(thumbFile, 'thumbnails');
              thumbnailUrl = thumbUrl;
            } catch (e) {
              console.warn('Thumbnail upload failed', e);
            }
          }
        } else {
          setUploadStep('Envoi de l\'image…');
          let lastImgProgress = 0;
          const { url } = await uploadToR2(media, 'post-images', undefined, (p) => {
            const now = Date.now();
            if (now - lastImgProgress > 250 || p.percent === 100) {
              lastImgProgress = now;
              setUploadPercent(p.percent);
            }
          });
          imageUrl = url;

          // Background age verification on first image post
          if (!profile?.age_verified && media.type.startsWith('image/')) {
            verifyAge(url);
          }
        }
      }

      let expiresAt: string | undefined;
      if (expiryHours) {
        const date = new Date();
        date.setHours(date.getHours() + expiryHours);
        expiresAt = date.toISOString();
      }

      let publishAt: string | undefined;
      if (capsuleDays) {
        const date = new Date();
        date.setDate(date.getDate() + capsuleDays);
        publishAt = date.toISOString();
      }

      setUploadStep('Publication…');

      // AI Threat Shield — bloque XSS / prompt-injection / SQLi avant publication
      try {
        const { inspectThreat } = await import('@/hooks/useThreatShield');
        const t = await inspectThreat({ endpoint: 'post.create', payload: body.trim() });
        if (t.blocked) {
          toast({
            title: '🛡️ Bouclier de sécurité',
            description: 'Ton message contient un motif d\'attaque (' + t.category + '). Publication bloquée.',
            variant: 'destructive',
          });
          setUploading(false);
          setUploadStep('');
          return;
        }
      } catch {}

      const newPost = await createPost.mutateAsync({ body: body.trim(), imageUrl, expiresAt, publishAt });

      // Zeus moderation check (async, non-blocking)
      if (body.trim()) {
        postModeration.mutate(
          { postId: (newPost as any)?.id || '', body: body.trim(), imageUrl },
          {
            onSuccess: (result) => {
              if (result && !result.safe) {
                toast({
                  title: '⚡ Message de Zeus',
                  description: result.zeus_message || 'Attention, ton contenu a été signalé.',
                  variant: 'destructive',
                  duration: 10000,
                });
              }
            },
          }
        );
      }

      // Reuse the same thumbnail for replay (no duplicate generation!)
      if (publishAsReplay && mediaType === 'video' && imageUrl) {
        await supabase.from('live_streams').insert({
          user_id: user.id,
          title: replayTitle.trim() || body.trim() || 'Replay',
          is_active: false,
          recording_url: imageUrl,
          thumbnail_url: thumbnailUrl,
          ended_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
        });
      }
      
      setBody('');
      removeMedia();
      setExpanded(false);
      setExpiryHours(null);
      setCapsuleDays(null);
      setPublishAsReplay(false);
      setReplayTitle('');

      // Scroll to top so user sees the new post immediately
      window.scrollTo({ top: 0, behavior: 'smooth' });

      // If on the dedicated create page, navigate back to feed
      if (window.location.pathname === '/create-post') {
        navigate('/feed');
      }
      
      // Silent post — no toast
    } catch (error) {
      toast({
        title: 'Erreur',
        description: 'Impossible de publier le post',
        variant: 'destructive',
      });
    } finally {
      setIsUploading(false);
      setUploadStep(null);
      setUploadPercent(0);
    }
  };

  if (!user) return null;

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative bg-card border-y border-border/20 sm:border sm:border-border/20 sm:rounded-[26px] overflow-hidden shadow-[0_12px_36px_-20px_hsl(var(--foreground)/0.18)]"
    >
      <div className="px-3 py-3 sm:px-4">
        <div className="flex gap-3 items-center">
          <motion.div whileTap={{ scale: 0.95 }}>
            <UserAvatar 
              src={profile?.avatar_url} 
              alt={profile?.name} 
              size="sm" 
              moodEmoji={(profile as any)?.mood_emoji}
            />
          </motion.div>
          
          <div className="flex-1 min-w-0">
            <AnimatePresence mode="wait">
              {!expanded ? (
                <motion.button
                  key="collapsed"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  onClick={() => {
                    setExpanded(true);
                    setTimeout(() => textareaRef.current?.focus(), 100);
                  }}
                  className="w-full text-left px-4 py-2.5 rounded-full bg-secondary/40 hover:bg-secondary/60 text-sm text-muted-foreground transition-all duration-300 border border-border/20"
                >
                  Quoi de neuf, {profile?.name?.split(' ')[0] || ''} ?
                </motion.button>
              ) : (
                <motion.div
                  key="expanded"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                >
                  <textarea
                    ref={textareaRef}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="Quoi de neuf ?"
                    className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none min-h-[80px] leading-relaxed"
                    autoFocus
                  />

                  {/* AI Enhance */}
                  {body.trim().length > 5 && !aiResult && (
                    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="mb-2">
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            disabled={aiLoading}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary/10 text-primary text-[11px] font-medium border border-primary/20 hover:bg-primary/15 transition-all"
                          >
                            {aiLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                            Améliorer avec l'IA
                          </button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-52 p-2 rounded-xl border-border/30">
                          <p className="text-[11px] font-semibold mb-2 px-2 text-foreground">✨ Assistant IA</p>
                          {AI_ACTIONS.map(a => (
                            <button
                              key={a.action}
                              onClick={() => { handleAiImprove(a.action); }}
                              disabled={aiLoading}
                              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-secondary/60 text-foreground transition-colors"
                            >
                              <a.icon className="w-3.5 h-3.5 text-primary" />
                              <div className="text-left">
                                <p className="text-xs font-medium">{a.label}</p>
                                <p className="text-[10px] text-muted-foreground">{a.desc}</p>
                              </div>
                            </button>
                          ))}
                        </PopoverContent>
                      </Popover>
                    </motion.div>
                  )}

                  {/* AI Result */}
                  <AnimatePresence>
                    {aiResult && (
                      <motion.div
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        className="mb-3 p-3 rounded-xl border border-primary/20 bg-primary/5 space-y-2"
                      >
                        <div className="flex items-center gap-2 justify-between">
                          <span className="text-[11px] font-semibold text-primary flex items-center gap-1">
                            <Sparkles className="w-3 h-3" /> Suggestion IA
                          </span>
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] px-2 py-0.5 rounded-md bg-secondary/50 text-muted-foreground flex items-center gap-1">
                              <Globe className="w-2.5 h-2.5" />
                              {LANG_LABELS[aiResult.detected_language] || aiResult.detected_language}
                            </span>
                            <span className="text-[10px] px-2 py-0.5 rounded-md bg-secondary/50 text-muted-foreground flex items-center gap-1">
                              <Type className="w-2.5 h-2.5" />
                              {aiResult.tone}
                            </span>
                          </div>
                        </div>
                        <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{aiResult.improved_text}</p>
                        {aiResult.corrections.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {aiResult.corrections.map((c, i) => (
                              <span key={i} className="text-[10px] px-2 py-0.5 rounded-md bg-primary/10 text-primary">{c}</span>
                            ))}
                          </div>
                        )}
                        <div className="flex gap-2 pt-1">
                          <Button size="sm" onClick={applyAiResult} className="h-7 px-3 text-[11px] rounded-lg gap-1">
                            <Check className="w-3 h-3" /> Appliquer
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setAiResult(null)} className="h-7 px-3 text-[11px] rounded-lg">
                            Ignorer
                          </Button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {expiryHours && (
                    <motion.div 
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="flex items-center gap-1.5 mb-2"
                    >
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[11px] font-medium border border-amber-500/20 shadow-[0_2px_8px_hsl(40_90%_50%/0.1)]">
                        <Timer className="w-3 h-3" />
                        Post éphémère · {expiryHours}h
                        <button onClick={() => setExpiryHours(null)} className="ml-1 hover:text-foreground transition-colors">
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    </motion.div>
                  )}

                  {capsuleDays && (
                    <motion.div 
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="flex items-center gap-1.5 mb-2"
                    >
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-violet-500/15 text-violet-600 dark:text-violet-400 text-[11px] font-medium border border-violet-500/20 shadow-[0_2px_8px_hsl(270_80%_50%/0.1)]">
                        <Rocket className="w-3 h-3" />
                        Capsule · dans {capsuleDays}j
                        <button onClick={() => setCapsuleDays(null)} className="ml-1 hover:text-foreground transition-colors">
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    </motion.div>
                  )}

                  {mediaPreview && (
                    <motion.div 
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="relative mt-2 rounded-xl overflow-hidden shadow-[var(--shadow-md)]"
                    >
                      {mediaType === 'video' ? (
                        <video src={mediaPreview} controls className="w-full max-h-52 object-cover rounded-xl" />
                      ) : (
                        <img src={mediaPreview} alt="Aperçu" className="w-full max-h-52 object-cover rounded-xl" />
                      )}
                      <Button
                        variant="secondary"
                        size="icon"
                        onClick={removeMedia}
                        className="absolute top-2 right-2 h-7 w-7 rounded-xl bg-background/80 backdrop-blur-sm hover:bg-destructive/10 hover:text-destructive transition-all"
                      >
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </motion.div>
                  )}

                  {/* Publish as Replay toggle — only for videos */}
                  {mediaType === 'video' && mediaPreview && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mt-2 space-y-2"
                    >
                      <button
                        type="button"
                        onClick={() => setPublishAsReplay(!publishAsReplay)}
                        className={cn(
                          "flex items-center gap-2 w-full px-3 py-2 rounded-xl text-[12px] font-medium transition-all border",
                          publishAsReplay
                            ? "bg-destructive/10 border-destructive/20 text-destructive"
                            : "bg-secondary/40 border-border/20 text-muted-foreground hover:bg-secondary/60"
                        )}
                      >
                        <Radio className={cn("w-3.5 h-3.5", publishAsReplay && "animate-pulse")} />
                        Publier aussi comme Replay (visible dans les lives)
                        {publishAsReplay && <Check className="w-3.5 h-3.5 ml-auto" />}
                      </button>
                      {publishAsReplay && (
                        <motion.input
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          type="text"
                          value={replayTitle}
                          onChange={(e) => setReplayTitle(e.target.value)}
                          placeholder="Titre du replay (optionnel)"
                          className="w-full px-3 py-2 rounded-xl bg-secondary/40 border border-border/20 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/30 transition-colors"
                        />
                      )}
                    </motion.div>
                  )}
                  
                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/20">
                    <input type="file" ref={fileInputRef} onChange={(e) => handleFileChange(e, 'image')} accept="image/*" className="hidden" />
                    <input type="file" ref={videoInputRef} onChange={(e) => handleFileChange(e, 'video')} accept="video/mp4,video/quicktime,video/x-m4v,.mp4,.mov,.m4v" className="hidden" />
                    
                    <div className="flex gap-0.5">
                      {[
                        { ref: fileInputRef, icon: Image, color: 'text-primary', hoverBg: 'hover:bg-primary/10 hover:text-primary' },
                        { ref: videoInputRef, icon: Video, color: 'text-destructive', hoverBg: 'hover:bg-destructive/10 hover:text-destructive' },
                      ].map((item, i) => (
                        <motion.div key={i} whileHover={{ scale: 1.1, y: -1 }} whileTap={{ scale: 0.9 }}>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => item.ref.current?.click()}
                            className={cn("h-9 w-9 rounded-xl text-muted-foreground transition-all duration-300", item.hoverBg)}
                          >
                            <item.icon className="w-[18px] h-[18px]" />
                          </Button>
                        </motion.div>
                      ))}
                      
                      <Popover>
                        <PopoverTrigger asChild>
                          <motion.div whileHover={{ scale: 1.1, y: -1 }} whileTap={{ scale: 0.9 }}>
                            <Button
                              variant="ghost"
                              size="icon"
                              className={cn(
                                "h-9 w-9 rounded-xl transition-all duration-300",
                                expiryHours 
                                  ? "text-amber-500 bg-amber-500/10 shadow-[0_0_8px_hsl(40_90%_50%/0.15)]" 
                                  : "text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10"
                              )}
                            >
                              <Timer className="w-[18px] h-[18px]" />
                            </Button>
                          </motion.div>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-48 p-2 rounded-xl glass border-border/30 shadow-[var(--shadow-lg)]">
                          <p className="text-xs font-semibold mb-2 px-2">Post éphémère ⏳</p>
                          {EXPIRY_OPTIONS.map(opt => (
                            <motion.button
                              key={opt.value}
                              whileHover={{ x: 2 }}
                              onClick={() => setExpiryHours(opt.value)}
                              className={cn(
                                "w-full text-left px-3 py-2 rounded-lg text-sm transition-all duration-200",
                                expiryHours === opt.value 
                                  ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium shadow-[inset_0_0_0_1px_hsl(40_90%_50%/0.2)]" 
                                  : "hover:bg-secondary/60 text-foreground"
                              )}
                            >
                              {opt.description}
                            </motion.button>
                          ))}
                          {expiryHours && (
                            <button
                              onClick={() => setExpiryHours(null)}
                              className="w-full text-left px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-secondary/60 transition-colors"
                            >
                              Annuler le minuteur
                            </button>
                          )}
                        </PopoverContent>
                      </Popover>

                      <Popover>
                        <PopoverTrigger asChild>
                          <motion.div whileHover={{ scale: 1.1, y: -1 }} whileTap={{ scale: 0.9 }}>
                            <Button
                              variant="ghost"
                              size="icon"
                              className={cn(
                                "h-9 w-9 rounded-xl transition-all duration-300",
                                capsuleDays 
                                  ? "text-violet-500 bg-violet-500/10 shadow-[0_0_8px_hsl(270_80%_50%/0.15)]" 
                                  : "text-muted-foreground hover:text-violet-500 hover:bg-violet-500/10"
                              )}
                            >
                              <Rocket className="w-[18px] h-[18px]" />
                            </Button>
                          </motion.div>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-48 p-2 rounded-xl glass border-border/30 shadow-[var(--shadow-lg)]">
                          <p className="text-xs font-semibold mb-2 px-2">Capsule temporelle 🚀</p>
                          {CAPSULE_OPTIONS.map(opt => (
                            <motion.button
                              key={opt.value}
                              whileHover={{ x: 2 }}
                              onClick={() => handleSetCapsule(opt.value)}
                              className={cn(
                                "w-full text-left px-3 py-2 rounded-lg text-sm transition-all duration-200",
                                capsuleDays === opt.value 
                                  ? "bg-violet-500/15 text-violet-600 dark:text-violet-400 font-medium shadow-[inset_0_0_0_1px_hsl(270_80%_50%/0.2)]" 
                                  : "hover:bg-secondary/60 text-foreground"
                              )}
                            >
                              {opt.label}
                            </motion.button>
                          ))}
                          {capsuleDays && (
                            <button
                              onClick={() => setCapsuleDays(null)}
                              className="w-full text-left px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-secondary/60 transition-colors"
                            >
                              Annuler la capsule
                            </button>
                          )}
                        </PopoverContent>
                      </Popover>
                    </div>
                    
                    <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                      <Button
                        onClick={handleSubmit}
                        disabled={(!body.trim() && !media) || isUploading}
                        size="sm"
                        className="h-9 px-5 text-xs rounded-xl bg-primary text-primary-foreground shadow-[0_2px_12px_hsl(220_70%_50%/0.3)] hover:shadow-[0_4px_20px_hsl(220_70%_50%/0.4)] hover:-translate-y-0.5 transition-all duration-300 btn-shine min-w-0 max-w-[160px] shrink-0"
                      >
                        {isUploading ? (
                          <span className="flex items-center gap-1.5 animate-pulse truncate">
                            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                            <span className="truncate">{uploadStep || 'Publication…'}</span>
                          </span>
                        ) : (
                          <>
                            <Send className="w-3.5 h-3.5 mr-1.5 shrink-0" />
                            Publier
                          </>
                        )}
                      </Button>
                    </motion.div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
      
      {/* Quick action row when collapsed */}
      <AnimatePresence>
        {!expanded && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center justify-around px-4 py-2.5 border-t border-border/20"
          >
            <input type="file" ref={fileInputRef} onChange={(e) => handleFileChange(e, 'image')} accept="image/*" className="hidden" />
            <input type="file" ref={videoInputRef} onChange={(e) => handleFileChange(e, 'video')} accept="video/mp4,video/quicktime,video/x-m4v,.mp4,.mov,.m4v" className="hidden" />
            {[
              { onClick: () => { setExpanded(true); setTimeout(() => textareaRef.current?.focus(), 100); window.dispatchEvent(new CustomEvent('open-zeus', { detail: { action: 'create-post' } })); }, icon: Sparkles, label: 'Zeus IA', iconColor: 'text-primary', hoverColor: 'hover:text-primary' },
              { onClick: () => fileInputRef.current?.click(), icon: Image, label: 'Photo', iconColor: 'text-primary/70', hoverColor: 'hover:text-primary' },
              { onClick: () => videoInputRef.current?.click(), icon: Video, label: 'Vidéo', iconColor: 'text-destructive/70', hoverColor: 'hover:text-destructive' },
              { onClick: () => { setExpanded(true); setExpiryHours(1); }, icon: Timer, label: 'Éphémère', iconColor: 'text-amber-500/70', hoverColor: 'hover:text-amber-500' },
            ].map((item, i) => (
              <motion.button
                key={i}
                whileHover={{ scale: 1.05, y: -1 }}
                whileTap={{ scale: 0.95 }}
                onClick={item.onClick}
                className={cn("flex items-center gap-2 text-xs text-muted-foreground transition-all duration-300 py-1.5 px-3 rounded-xl hover:bg-secondary/50", item.hoverColor)}
              >
                <item.icon className={cn("w-4 h-4", item.iconColor)} />
                <span className="font-medium">{item.label}</span>
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
