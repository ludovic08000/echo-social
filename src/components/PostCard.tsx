import { useEffect, useRef, useState, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { MessageCircle, Trash2, MoreHorizontal, ThumbsUp, Sparkles, Languages, Loader2, Timer, Bookmark, ShieldAlert, AlertTriangle, Eye, Send, Globe } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Post, useDeletePost } from '@/hooks/usePosts';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { UserAvatar } from './UserAvatar';
import { TrustBadge } from './TrustBadge';
import { CreatorBadge } from './CreatorBadge';
import { useIsCreator } from '@/hooks/useCreator';
import { Button } from '@/components/ui/button';
import { ReactionButton } from './ReactionButton';
import { cn } from '@/lib/utils';
import { ReactionType, REACTION_EMOJIS } from '@/hooks/useReactions';
import { ShareButton } from './ShareButton';
import { generatePostUrl } from '@/lib/urlUtils';
import { useAIContent } from '@/hooks/useAIContent';
import { useCurrentUserIsMinor } from '@/hooks/useMinorProtection';
import { useReportUser } from '@/hooks/useTrustAndSafety';
import { toast } from 'sonner';
import { FeedAutoplayVideo } from './FeedAutoplayVideo';
import { useIsMobile } from '@/hooks/use-mobile';
import { imagePresets } from '@/lib/imageOptimize';
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
  const navigate = useNavigate();
  const deletePost = useDeletePost();
  const { data: isPostAuthorCreator } = useIsCreator(post.user_id);
  const { summarize, translate, summaryLoading, translateLoading, aiSummariesEnabled, autoTranslateEnabled } = useAIContent();
  const [summary, setSummary] = useState<string | null>(null);
  const [translation, setTranslation] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<string | null>(null);
  const [mediaLoaded, setMediaLoaded] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [viewTracked, setViewTracked] = useState(false);
  const { data: isMinorUser } = useCurrentUserIsMinor();
  const reportUser = useReportUser();
  const isMobile = useIsMobile();

  const postUrl = generatePostUrl(post.id);
  const isVideoPost = Boolean(post.image_url && /\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i.test(post.image_url));

  const { data: videoViewCount } = useQuery({
    queryKey: ['post-views', post.id],
    queryFn: async () => {
      const { count } = await supabase
        .from('post_views')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', post.id);
      return count || 0;
    },
    enabled: isVideoPost,
    staleTime: 60_000,
  });

  // Fetch top 2 reaction types for the post
  const { data: topReactions } = useQuery({
    queryKey: ['post-top-reactions', post.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('likes')
        .select('reaction_type')
        .eq('post_id', post.id)
        .not('reaction_type', 'is', null);
      if (!data || data.length === 0) return ['like'];
      const counts: Record<string, number> = {};
      data.forEach((r: any) => { counts[r.reaction_type] = (counts[r.reaction_type] || 0) + 1; });
      return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([type]) => type);
    },
    enabled: post.likes_count > 0,
    staleTime: 60_000,
  });

  const trackVideoView = () => {
    if (viewTracked || !user || !isVideoPost) return;
    setViewTracked(true);
    supabase.from('post_views').upsert({
      post_id: post.id,
      user_id: user.id,
    }, { onConflict: 'post_id,user_id' }).then(() => {});
  };

  useEffect(() => {
    setMediaLoaded(false);
    setVideoError(false);
    setViewTracked(false);
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
    deletePost.mutate(post.id);
  };

  const handleCommentClick = () => {
    if (onCommentClick) {
      onCommentClick();
    } else {
      navigate(`/post/${post.id}#comments`);
    }
  };

  const isOwner = user?.id === post.user_id;

  return (
    <article className="group relative bg-card border-y border-border/20 sm:border sm:border-border/20 sm:rounded-[26px] transition-all duration-300 shadow-[0_10px_34px_-22px_hsl(var(--foreground)/0.2)] hover:shadow-[0_18px_44px_-24px_hsl(var(--foreground)/0.24)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <Link to={`/profile/${post.user_id}`} className="relative flex-shrink-0">
            <UserAvatar 
              src={post.profile.avatar_url} 
              alt={post.profile.name} 
              size="sm" 
              moodEmoji={post.profile.mood_emoji}
            />
          </Link>
          
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <Link 
                to={`/profile/${post.user_id}`}
                className="font-semibold text-[13px] text-foreground hover:text-primary transition-colors truncate"
              >
                {post.profile.name}
              </Link>
              <TrustBadge userId={post.user_id} size="sm" />
              {isPostAuthorCreator && <CreatorBadge size="sm" />}
            </div>
            <div className="flex items-center gap-1.5">
              <Link to={`/post/${post.id}`}>
                <span className="text-muted-foreground text-[11px] hover:text-foreground transition-colors">
                  {formatDistanceToNow(new Date(post.created_at), { addSuffix: true, locale: fr })}
                </span>
              </Link>
              <Globe className="w-2.5 h-2.5 text-muted-foreground" />
              {timeLeft && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-medium">
                  <Timer className="w-2.5 h-2.5" />
                  {timeLeft}
                </span>
              )}
            </div>
          </div>
        </div>
        
        <div className="flex items-center">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="h-8 w-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors">
                <MoreHorizontal className="w-5 h-5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="rounded-xl border-border/30 shadow-lg">
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
              <DropdownMenuItem onClick={() => setSaved(!saved)}>
                <Bookmark className={cn("w-4 h-4 mr-2", saved && "fill-current")} />
                {saved ? 'Retirer' : 'Enregistrer'}
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
                  Signaler
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Text content — above media like Facebook */}
      {post.body && (
        <div className="px-3 pb-2">
          <p className="text-[14px] text-foreground leading-[1.5] whitespace-pre-wrap break-words">
            {post.body}
          </p>
        </div>
      )}

      {/* AI Actions — translate / summarize */}
      {post.body && (aiSummariesEnabled || autoTranslateEnabled) && (
        <div className="px-3 pb-2 flex flex-wrap gap-1.5">
          {aiSummariesEnabled && post.body.length >= 100 && (
            <button
              onClick={handleSummarize}
              disabled={summaryLoading}
              className={cn(
                "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all",
                summary
                  ? "bg-primary/10 text-primary"
                  : "bg-secondary/40 text-muted-foreground hover:bg-secondary/60"
              )}
            >
              {summaryLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              {summary ? 'Masquer' : 'Résumer'}
            </button>
          )}
          {autoTranslateEnabled && (
            <button
              onClick={handleTranslate}
              disabled={translateLoading}
              className={cn(
                "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all",
                translation
                  ? "bg-primary/10 text-primary"
                  : "bg-secondary/40 text-muted-foreground hover:bg-secondary/60"
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
        <div className="px-3 pb-2 space-y-2">
          {summary && (
            <div className="p-2.5 rounded-xl bg-secondary/30 border border-border/20">
              <div className="flex items-center gap-1.5 mb-1">
                <Sparkles className="w-3 h-3 text-primary" />
                <span className="text-[10px] font-semibold text-primary uppercase tracking-wider">Résumé IA</span>
              </div>
              <p className="text-[13px] text-foreground leading-relaxed">{summary}</p>
            </div>
          )}
          {translation && (
            <div className="p-2.5 rounded-xl bg-secondary/30 border border-border/20">
              <div className="flex items-center gap-1.5 mb-1">
                <Languages className="w-3 h-3 text-primary" />
                <span className="text-[10px] font-semibold text-primary uppercase tracking-wider">Traduction</span>
              </div>
              <p className="text-[13px] text-foreground leading-relaxed">{translation}</p>
            </div>
          )}
        </div>
      )}

      {/* Media — full width */}
      {post.image_url && (
        <div className="relative w-full overflow-hidden bg-muted/30">
          {!mediaLoaded && !videoError && (
            <div className="absolute inset-0 skeleton aspect-[4/5]" />
          )}
          {isVideoPost ? (
            videoError ? (
              <div className="aspect-[4/5] flex items-center justify-center bg-muted/70">
                <div className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-background/80 border border-border/40">
                  <AlertTriangle className="w-4 h-4 text-destructive" />
                  <span className="text-xs font-medium text-foreground">Format vidéo non supporté</span>
                </div>
              </div>
            ) : (
              <>
                <FeedAutoplayVideo
                  src={post.image_url!}
                  onMediaLoaded={() => setMediaLoaded(true)}
                  onVideoError={() => { setMediaLoaded(true); setVideoError(true); }}
                  onPlay={() => trackVideoView()}
                />
                {typeof videoViewCount === 'number' && videoViewCount > 0 && (
                  <div className="absolute bottom-2 left-2 z-10 flex items-center gap-1 text-white text-xs bg-black/60 backdrop-blur-sm rounded-lg px-2 py-1">
                    <Eye className="w-3.5 h-3.5" />
                    <span>{videoViewCount > 1000 ? `${(videoViewCount / 1000).toFixed(1)}K` : videoViewCount}</span>
                  </div>
                )}
              </>
            )
          ) : (
            <Link to={`/post/${post.id}`}>
              <img
                src={imagePresets.postThumbnail(post.image_url) || post.image_url}
                alt="Image du post"
                loading="lazy"
                decoding="async"
                className={cn(
                  "w-full transition-opacity duration-300",
                  mediaLoaded ? "opacity-100" : "opacity-0"
                )}
                onLoad={() => setMediaLoaded(true)}
              />
            </Link>
          )}
        </div>
      )}

      {/* Engagement summary — Facebook style */}
      {showActions && (
        <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
          {/* Left: reaction emojis + count */}
          {post.likes_count > 0 ? (
            <div className="flex items-center gap-1.5">
              <div className="flex -space-x-1">
                {(topReactions || ['like']).map((type, i) => (
                  <span 
                    key={type} 
                    className="w-[18px] h-[18px] rounded-full bg-primary/10 flex items-center justify-center text-[11px] ring-2 ring-card"
                    style={{ zIndex: 2 - i }}
                  >
                    {REACTION_EMOJIS[type as ReactionType] || '👍'}
                  </span>
                ))}
              </div>
              <span className="text-[13px] text-muted-foreground">
                {post.likes_count}
              </span>
            </div>
          ) : <div />}
          
          {/* Right: comment count — always visible */}
          <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
            <button 
              onClick={handleCommentClick}
              className="hover:text-foreground transition-colors hover:underline"
            >
              {post.comments_count} commentaire{post.comments_count !== 1 ? 's' : ''}
            </button>
          </div>
        </div>
      )}

      {/* Action bar — Facebook style: 3 equal buttons */}
      {showActions && (
        <>
          <div className="mx-3 border-t border-border/20" />
          <div className="flex items-center px-1 py-0.5">
            <ReactionButton 
              postId={post.id}
              currentReaction={post.user_reaction}
              reactionsCount={0}
              variant="facebook"
            />
            <Button
              variant="ghost"
              size="sm"
              className="flex-1 h-11 gap-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-xl text-xs"
              onClick={handleCommentClick}
            >
              <MessageCircle className="w-[18px] h-[18px]" />
              <span className="font-medium">Commenter{post.comments_count > 0 ? ` (${post.comments_count})` : ''}</span>
            </Button>
            <ShareButton
              url={postUrl}
              title={`Post de ${post.profile.name}`}
              text={post.body?.slice(0, 100)}
              variant="ghost"
              className="flex-1 h-11 gap-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-xl text-xs font-medium"
              showLabel
            />
          </div>
        </>
      )}

      {/* Mobile separator */}
      <div className="h-2 bg-secondary/30 sm:hidden" />
    </article>
  );
}, (prev, next) => {
  return prev.post.id === next.post.id
    && prev.post.likes_count === next.post.likes_count
    && prev.post.comments_count === next.post.comments_count
    && prev.post.user_reaction === next.post.user_reaction;
});
