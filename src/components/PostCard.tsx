import { useEffect, useRef, useState, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { MessageCircle, Trash2, MoreHorizontal, ThumbsUp, Sparkles, Languages, Loader2, Timer, Bookmark, ShieldAlert, Play, AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Post, useDeletePost } from '@/hooks/usePosts';
import { useAuth } from '@/lib/auth';
import { UserAvatar } from './UserAvatar';
import { TrustBadge } from './TrustBadge';
import { CreatorBadge } from './CreatorBadge';
import { useIsCreator } from '@/hooks/useCreator';
import { Button } from '@/components/ui/button';
import { ReactionButton } from './ReactionButton';
import { cn } from '@/lib/utils';
import { ReactionType } from '@/hooks/useReactions';
import { ShareButton } from './ShareButton';
import { generatePostUrl } from '@/lib/urlUtils';
import { useAIContent } from '@/hooks/useAIContent';
import { useCurrentUserIsMinor } from '@/hooks/useMinorProtection';
import { useReportUser } from '@/hooks/useTrustAndSafety';
import { toast } from 'sonner';
import { useIsMobile } from '@/hooks/use-mobile';
import { guessVideoMime } from '@/lib/videoCompat';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface PostCardProps {
  post: Post & { user_reaction?: ReactionType | null };
  showActions?: boolean;
  onCommentClick?: () => void;
}

export const PostCard = memo(function PostCard({ post, showActions = true, onCommentClick }: PostCardProps) {
  const { user } = useAuth();
  const deletePost = useDeletePost();
  const { data: isPostAuthorCreator } = useIsCreator(post.user_id);
  const { summarize, translate, summaryLoading, translateLoading, aiSummariesEnabled, autoTranslateEnabled } = useAIContent();
  const [summary, setSummary] = useState<string | null>(null);
  const [translation, setTranslation] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<string | null>(null);
  const [mediaLoaded, setMediaLoaded] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [saved, setSaved] = useState(false);
  const { data: isMinorUser } = useCurrentUserIsMinor();
  const reportUser = useReportUser();
  const isMobile = useIsMobile();

  const postUrl = generatePostUrl(post.id);
  const isVideoPost = Boolean(post.image_url && /\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i.test(post.image_url));

  useEffect(() => {
    setMediaLoaded(false);
    setVideoError(false);
  }, [post.id]);

  useEffect(() => {
    if (!post.expires_at) return;
    const updateCountdown = () => {
      const now = new Date().getTime();
      const exp = new Date(post.expires_at!).getTime();
      const diff = exp - now;
      if (diff <= 0) { setTimeLeft('Expiré'); return; }
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      setTimeLeft(hours > 0 ? `${hours}h${mins.toString().padStart(2, '0')}` : `${mins}min`);
    };
    updateCountdown();
    const interval = setInterval(updateCountdown, 30000);
    return () => clearInterval(interval);
  }, [post.expires_at]);

  const handleSummarize = async () => {
    if (summary) { setSummary(null); return; }
    const result = await summarize(post.body || '');
    if (result) setSummary(result);
  };

  const handleTranslate = async () => {
    if (translation) { setTranslation(null); return; }
    const result = await translate(post.body || '');
    if (result) setTranslation(result);
  };

  const handleDelete = () => {
    if (confirm('Êtes-vous sûr de vouloir supprimer ce post ?')) {
      deletePost.mutate(post.id);
    }
  };

  const isOwner = user?.id === post.user_id;

  return (
    <article className="group relative bg-card border border-border/20 rounded-2xl overflow-hidden">
      {/* Subtle gradient overlay on hover */}
      
      
      {/* Header */}
      <div className="relative flex items-center justify-between px-4 pt-4 pb-3">
        <div className="flex items-center gap-3">
          <Link to={`/profile/${post.user_id}`} className="relative">
              <UserAvatar 
                src={post.profile.avatar_url} 
                alt={post.profile.name} 
                size="md" 
                moodEmoji={post.profile.mood_emoji}
              />
            <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-emerald-500 border-2 border-card" />
          </Link>
          
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Link 
                to={`/profile/${post.user_id}`}
                className="font-semibold text-sm text-foreground hover:text-primary transition-colors block truncate"
              >
                {post.profile.name}
              </Link>
              <TrustBadge userId={post.user_id} size="sm" />
              {isPostAuthorCreator && <CreatorBadge size="sm" />}
            </div>
            <div className="flex items-center gap-1.5">
              <Link to={`/post/${post.id}`}>
                <span className="text-muted-foreground text-xs hover:text-foreground transition-colors">
                  {formatDistanceToNow(new Date(post.created_at), { addSuffix: true, locale: fr })}
                </span>
              </Link>
              {timeLeft && (
                isMobile ? (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-medium backdrop-blur-sm">
                    <Timer className="w-2.5 h-2.5" />
                    {timeLeft}
                  </span>
                ) : (
                  <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-medium backdrop-blur-sm">
                    <Timer className="w-2.5 h-2.5" />
                    {timeLeft}
                  </motion.span>
                )
              )}
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-1">
          <button
            onClick={() => setSaved(!saved)}
            className={cn(
              "h-8 w-8 rounded-xl flex items-center justify-center transition-colors",
              saved ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
            )}
          >
            <Bookmark className={cn("w-4 h-4", saved && "fill-current")} />
          </button>
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-xl text-muted-foreground hover:text-foreground">
                <MoreHorizontal className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="rounded-xl glass border-border/30 shadow-[var(--shadow-lg)]">
              <DropdownMenuItem asChild>
                <ShareButton 
                  url={postUrl} 
                  title={`Post de ${post.profile.name}`}
                  text={post.body?.slice(0, 100)}
                  variant="ghost"
                  showLabel
                  className="w-full justify-start p-0"
                />
              </DropdownMenuItem>
              {isOwner && (
                <DropdownMenuItem onClick={handleDelete} className="text-destructive">
                  <Trash2 className="w-4 h-4 mr-2" />
                  Supprimer
                </DropdownMenuItem>
              )}
              {!isOwner && (
                <DropdownMenuItem 
                  onClick={async () => {
                    try {
                      await reportUser.mutateAsync({
                        reportedUserId: post.user_id,
                        reportType: 'inappropriate_content',
                        description: `Signalement - post ${post.id}`,
                      });
                      toast.success('✅ Signalement envoyé !');
                    } catch {
                      toast.error('Erreur lors du signalement');
                    }
                  }}
                  className="text-destructive"
                >
                  <ShieldAlert className="w-4 h-4 mr-2" />
                  Signaler ce contenu
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Content */}
      <div className="block relative">
        {post.body && (
          <Link to={`/post/${post.id}`}>
            <p className="px-4 pb-3 text-sm text-foreground whitespace-pre-wrap break-words leading-relaxed">
              {post.body}
            </p>
          </Link>
        )}
        
        {post.image_url && (
          <div className="relative w-full overflow-hidden bg-muted/40 aspect-[4/5] sm:aspect-video">
            {!mediaLoaded && !(isVideoPost && isIOSUnsafeVideo) && (
              <div className="absolute inset-0 skeleton" />
            )}
            {isVideoPost ? (
              isIOSUnsafeVideo ? (
                <div className="absolute inset-0 flex items-center justify-center bg-muted/70">
                  <div className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-background/80 border border-border/40">
                    <Play className="w-4 h-4 text-foreground" />
                    <span className="text-xs font-medium text-foreground">Vidéo non compatible iPhone</span>
                  </div>
                </div>
              ) : (
                <video
                  ref={videoRef}
                  controls
                  playsInline
                  // @ts-ignore – legacy iOS attribute
                  webkit-playsinline=""
                  x-webkit-airplay="deny"
                  controlsList="nodownload noremoteplayback"
                  preload="metadata"
                  className={cn(
                    "absolute inset-0 w-full h-full object-cover bg-muted transition-opacity duration-300",
                    mediaLoaded ? "opacity-100" : "opacity-0"
                  )}
                  onLoadedData={() => setMediaLoaded(true)}
                  onError={() => setMediaLoaded(true)}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <source src={post.image_url!} type={guessVideoMime(post.image_url!)} />
                </video>
              )
            ) : (
              <Link to={`/post/${post.id}`}>
                <img
                  src={post.image_url}
                  alt="Image du post"
                  className={cn(
                    "absolute inset-0 w-full h-full object-cover transition-opacity duration-300",
                    mediaLoaded ? "opacity-100" : "opacity-0"
                  )}
                  onLoad={() => setMediaLoaded(true)}
                  loading="lazy"
                />
              </Link>
            )}
          </div>
        )}
      </div>

      {/* AI Actions */}
      {post.body && (aiSummariesEnabled || autoTranslateEnabled) && (
        <div className="relative px-4 pb-2 flex flex-wrap gap-1.5">
          {aiSummariesEnabled && post.body.length >= 100 && (
            <button
              onClick={handleSummarize}
              disabled={summaryLoading}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-medium transition-all border backdrop-blur-sm",
                summary
                  ? "bg-primary/10 text-primary border-primary/30 shadow-[0_2px_8px_hsl(220_70%_50%/0.12)]"
                  : "bg-secondary/40 text-muted-foreground border-border/30 hover:bg-secondary/60 hover:border-primary/20 hover:shadow-[0_2px_8px_hsl(220_70%_50%/0.08)]"
              )}
            >
              {summaryLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              {summary ? 'Masquer résumé' : 'Résumer'}
            </button>
          )}
          {autoTranslateEnabled && (
            <button
              onClick={handleTranslate}
              disabled={translateLoading}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-medium transition-all border backdrop-blur-sm",
                translation
                  ? "bg-primary/10 text-primary border-primary/30 shadow-[0_2px_8px_hsl(220_70%_50%/0.12)]"
                  : "bg-secondary/40 text-muted-foreground border-border/30 hover:bg-secondary/60 hover:border-primary/20 hover:shadow-[0_2px_8px_hsl(220_70%_50%/0.08)]"
              )}
            >
              {translateLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Languages className="w-3 h-3" />}
              {translation ? 'Original' : 'Traduire'}
            </button>
          )}
        </div>
      )}

      {/* AI Results */}
      {(summary || translation) && (
        <div className="relative px-4 pb-3 space-y-2">
          {summary && (
            <div className="p-3 rounded-xl glass border-primary/20 shadow-[0_2px_12px_hsl(220_70%_50%/0.06)]">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Sparkles className="w-3 h-3 text-primary" />
                <span className="text-[10px] font-semibold text-primary uppercase tracking-wider">Résumé IA</span>
              </div>
              <p className="text-sm text-foreground leading-relaxed">{summary}</p>
            </div>
          )}
          {translation && (
            <div className="p-3 rounded-xl glass border-primary/20 shadow-[0_2px_12px_hsl(220_70%_50%/0.06)]">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Languages className="w-3 h-3 text-primary" />
                <span className="text-[10px] font-semibold text-primary uppercase tracking-wider">Traduction</span>
              </div>
              <p className="text-sm text-foreground leading-relaxed">{translation}</p>
            </div>
          )}
        </div>
      )}

      {/* Reactions Count */}
      {(post.likes_count > 0 || post.comments_count > 0) && (
        <div className="relative flex items-center justify-between px-4 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            {post.likes_count > 0 && (
              <div className="flex items-center gap-1">
                <div className="w-[18px] h-[18px] rounded-full bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center shadow-[0_2px_6px_hsl(220_70%_50%/0.3)]">
                  <ThumbsUp className="w-2.5 h-2.5 text-primary-foreground" />
                </div>
                <span className="font-medium">{post.likes_count}</span>
              </div>
            )}
          </div>
          {post.comments_count > 0 && (
            <button onClick={onCommentClick} className="hover:text-foreground transition-colors hover:underline">
              {post.comments_count} commentaire{post.comments_count > 1 ? 's' : ''}
            </button>
          )}
        </div>
      )}
      
      {/* Actions */}
      {showActions && (
        <div className="relative flex items-center border-t border-border/20 mx-4 py-1">
          <ReactionButton 
            postId={post.id}
            currentReaction={post.user_reaction}
            reactionsCount={0}
            variant="facebook"
          />
          
          <div className="flex-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={onCommentClick}
              className="w-full h-11 gap-2 text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-xl text-xs transition-all"
            >
              <MessageCircle className="w-[18px] h-[18px]" />
              <span className="font-medium">Commenter</span>
            </Button>
          </div>
          
          <div className="flex-1">
            <ShareButton
              url={postUrl}
              title={`Post de ${post.profile.name}`}
              text={post.body?.slice(0, 100)}
              variant="ghost"
              size="sm"
              showLabel
              className="w-full h-11 gap-2 text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-xl text-xs"
            />
          </div>
        </div>
      )}
    </article>
  );
}, (prev, next) => {
  return prev.post.id === next.post.id
    && prev.post.likes_count === next.post.likes_count
    && prev.post.comments_count === next.post.comments_count
    && prev.post.is_liked === next.post.is_liked
    && prev.post.user_reaction === next.post.user_reaction;
});
