import { useState, useRef, useCallback } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { Trash2, Send, Smile, Camera, Languages, Loader2, ChevronDown, Wand2, CornerDownRight } from 'lucide-react';
import { sanitizeUrl } from '@/lib/sanitizeUrl';
import { supabase } from '@/integrations/supabase/client';
import { useComments, useCreateComment, useDeleteComment, useLikeComment, Comment } from '@/hooks/useComments';
import { REACTION_EMOJIS, REACTION_LABELS, ReactionType } from '@/hooks/useReactions';
import { useAuth } from '@/lib/auth';
import { UserAvatar } from './UserAvatar';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { GifPicker } from '@/components/chat/GifPicker';
import { useR2Upload } from '@/hooks/useR2Upload';
import { toast } from 'sonner';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

const EMOJI_CATEGORIES = [
  {
    label: '😊',
    emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😊','😇','🥰','😍','🤩','😘','😗','😚','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🫡'],
  },
  {
    label: '❤️',
    emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','❤️‍🩹','💕','💞','💓','💗','💖','💝','💘','🫶','💯','💢','💥','💫','💦','💨'],
  },
  {
    label: '👋',
    emojis: ['👍','👎','👏','🙌','🤝','✊','👊','🤛','🤜','🤞','✌️','🤟','🤘','👌','🤌','🤏','👈','👉','👆','👇','☝️','✋','🤚','🖐️','🖖','👋','🫱','🫲'],
  },
  {
    label: '🐱',
    emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐒','🦍','🦧','🐔','🐧','🐦','🦅','🦆'],
  },
  {
    label: '🍔',
    emojis: ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🥑','🍔','🍟','🍕','🌭','🥪','🌮','🌯'],
  },
  {
    label: '⚽',
    emojis: ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','🥊','🥋','🎯','⛳','🎮','🕹️','🎲','🧩','♟️','🎭','🎨','🎬'],
  },
  {
    label: '🚀',
    emojis: ['🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🛵','🏍️','🛺','✈️','🚀','🛸','🚁','⛵','🚤','🛥️','🛳️','⚓'],
  },
];

interface CommentsListProps {
  postId: string;
}

export function CommentsList({ postId }: CommentsListProps) {
  const { user } = useAuth();
  const { data: comments, isLoading } = useComments(postId);
  const createComment = useCreateComment();
  const deleteComment = useDeleteComment();
  const [newComment, setNewComment] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(null);
  const [attachedMedia, setAttachedMedia] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<'image' | 'gif' | 'video' | null>(null);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [aiLoading, setAiLoading] = useState<'translate' | 'improve' | null>(null);
  const [emojiCategory, setEmojiCategory] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { upload } = useR2Upload({ folder: 'images', maxSizeMB: 20 });

  const handleAI = async (action: 'translate' | 'improve') => {
    if (!newComment.trim() || aiLoading) return;
    setAiLoading(action);
    try {
      const prompt = action === 'translate'
        ? `Détecte la langue du texte suivant et traduis-le en français si ce n'est pas du français, sinon traduis-le en anglais. Réponds UNIQUEMENT avec la traduction, rien d'autre : "${newComment}"`
        : `Corrige l'orthographe, la grammaire et améliore le style de ce texte tout en gardant le même sens et la même langue. Réponds UNIQUEMENT avec le texte amélioré, rien d'autre : "${newComment}"`;
      const { data } = await supabase.functions.invoke('zeus', {
        body: { message: prompt, context: action === 'translate' ? 'translation' : 'correction' }
      });
      if (data?.reply) setNewComment(data.reply.replace(/^["']|["']$/g, ''));
    } catch {
      toast.error("Erreur IA, réessayez");
    } finally {
      setAiLoading(null);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      window.location.href = '/signup';
      return;
    }
    if ((!newComment.trim() && !attachedMedia) || !user) return;

    let body = newComment.trim();
    if (attachedMedia) {
      if (mediaType === 'gif') {
        body = body ? `${body}\nGIF:${attachedMedia}` : `GIF:${attachedMedia}`;
      } else {
        body = body ? `${body}\n${attachedMedia}` : attachedMedia;
      }
    }

    createComment.mutate(
      { postId, body, parentId: replyTo?.id },
      {
        onSuccess: () => {
          setNewComment('');
          setAttachedMedia(null);
          setMediaType(null);
          setReplyTo(null);
        },
      }
    );
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isVideo = file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');
    if (!isVideo && !isImage) { toast.error('Format non supporté.'); return; }
    if (file.size > 20 * 1024 * 1024) { toast.error('Fichier trop volumineux (max 20 Mo)'); return; }

    setUploading(true);
    try {
      const url = await upload(file);
      if (url) { setAttachedMedia(url); setMediaType(isVideo ? 'video' : 'image'); }
    } catch { toast.error("Erreur lors de l'upload"); }
    finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  };

  const handleGifSelect = (gifUrl: string) => {
    setAttachedMedia(gifUrl);
    setMediaType('gif');
    setShowGifPicker(false);
  };

  const handleReply = (comment: Comment) => {
    setReplyTo({ id: comment.id, name: comment.profile.name });
    inputRef.current?.focus();
  };

  if (isLoading) {
    return (
      <div className="space-y-4 p-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3 animate-pulse">
            <div className="w-8 h-8 rounded-full bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-24 bg-muted rounded" />
              <div className="h-4 w-full bg-muted rounded" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <button className="flex items-center gap-1 px-4 py-2.5 text-[14px] font-semibold text-foreground">
        Plus pertinents
        <ChevronDown className="w-4 h-4" />
      </button>

      <div className="px-4 pb-4 space-y-1 max-h-[60vh] overflow-y-auto">
        {comments?.length === 0 ? (
          <p className="text-muted-foreground text-center py-6 text-sm">
            Aucun commentaire pour le moment
          </p>
        ) : (
          comments?.map((comment) => (
            <div key={comment.id}>
              <CommentItem
                comment={comment}
                isOwner={user?.id === comment.user_id}
                onDelete={() => deleteComment.mutate({ commentId: comment.id, postId })}
                onReply={() => handleReply(comment)}
                postId={postId}
              />
              {/* Threaded replies with visual connector lines */}
              {comment.replies && comment.replies.length > 0 && (
                <div className="ml-5 relative">
                  {/* Vertical thread line */}
                  <div className="absolute left-[15px] top-0 bottom-3 w-[2px] bg-border/40 rounded-full" />
                  <div className="space-y-1">
                    {comment.replies.map((reply, idx) => (
                      <div key={reply.id} className="relative pl-8">
                        {/* Horizontal branch line */}
                        <div className="absolute left-[15px] top-[18px] w-[14px] h-[2px] bg-border/40 rounded-full" />
                        {/* Dot at junction */}
                        <div className="absolute left-[13px] top-[15px] w-[6px] h-[6px] rounded-full bg-border/60" />
                        <CommentItem
                          comment={reply}
                          isOwner={user?.id === reply.user_id}
                          onDelete={() => deleteComment.mutate({ commentId: reply.id, postId })}
                          onReply={() => handleReply(comment)}
                          postId={postId}
                          isReply
                          parentName={comment.profile.name}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Media preview */}
      {attachedMedia && (
        <div className="px-4 pb-2">
          <div className="relative inline-block rounded-xl overflow-hidden border border-border/30">
            {mediaType === 'video' ? (
              <video src={attachedMedia} className="max-h-32 rounded-xl" controls />
            ) : (
              <img src={attachedMedia} alt="Pièce jointe" className="max-h-32 rounded-xl object-cover" />
            )}
            <button
              onClick={() => { setAttachedMedia(null); setMediaType(null); }}
              className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white flex items-center justify-center text-xs"
            >×</button>
          </div>
        </div>
      )}

      {showGifPicker && (
        <div className="px-4 pb-2">
          <GifPicker onSelect={handleGifSelect} onClose={() => setShowGifPicker(false)} />
        </div>
      )}

      {/* Reply indicator */}
      {replyTo && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-secondary/30 border-t border-border/20">
          <CornerDownRight className="w-3.5 h-3.5 text-primary" />
          <span className="text-[12px] text-muted-foreground">
            Réponse à <span className="font-semibold text-foreground">{replyTo.name}</span>
          </span>
          <button onClick={() => setReplyTo(null)} className="ml-auto text-muted-foreground hover:text-foreground text-xs">✕</button>
        </div>
      )}

      {/* Comment input */}
      {user && (
        <div className="flex items-center gap-2 px-3 py-2.5 border-t border-border/30 bg-card">
          <UserAvatar size="sm" />
          <form onSubmit={handleSubmit} className="flex-1 flex items-center gap-1.5">
            <div className="flex-1 relative">
              <input
                ref={inputRef}
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder={replyTo ? `Répondre à ${replyTo.name}...` : "Commentez..."}
                className="w-full bg-secondary/50 rounded-full px-4 py-2 pr-36 text-[13px] outline-none placeholder:text-muted-foreground focus:bg-secondary/70 transition-colors"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                {newComment.trim() && (
                  <>
                    <button type="button" onClick={() => handleAI('translate')} disabled={!!aiLoading} className="p-1 rounded-full text-muted-foreground hover:text-primary transition-colors" title="Traduire">
                      {aiLoading === 'translate' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Languages className="w-3.5 h-3.5" />}
                    </button>
                    <button type="button" onClick={() => handleAI('improve')} disabled={!!aiLoading} className="p-1 rounded-full text-muted-foreground hover:text-primary transition-colors" title="Corriger & améliorer">
                      {aiLoading === 'improve' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                    </button>
                  </>
                )}
                {/* Emoji picker with categories */}
                <Popover>
                  <PopoverTrigger asChild>
                    <button type="button" className="p-1 rounded-full text-muted-foreground hover:text-foreground transition-colors">
                      <Smile className="w-4 h-4" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent side="top" align="end" className="w-72 p-0 rounded-xl overflow-hidden" sideOffset={8}>
                    {/* Category tabs */}
                    <div className="flex border-b border-border/30 bg-secondary/30 px-1 py-1 gap-0.5 overflow-x-auto scrollbar-hide">
                      {EMOJI_CATEGORIES.map((cat, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setEmojiCategory(i)}
                          className={cn(
                            "w-8 h-8 flex items-center justify-center text-base rounded-lg transition-colors flex-shrink-0",
                            emojiCategory === i ? "bg-primary/15 scale-110" : "hover:bg-secondary"
                          )}
                        >
                          {cat.label}
                        </button>
                      ))}
                    </div>
                    {/* Emoji grid */}
                    <div className="p-2 max-h-[200px] overflow-y-auto">
                      <div className="grid grid-cols-8 gap-0.5">
                        {EMOJI_CATEGORIES[emojiCategory].emojis.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => setNewComment(prev => prev + emoji)}
                            className="w-8 h-8 flex items-center justify-center text-xl hover:bg-secondary rounded-lg transition-all hover:scale-125 active:scale-95"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
                <button type="button" onClick={() => setShowGifPicker(!showGifPicker)} className="p-1 rounded-full text-muted-foreground hover:text-foreground transition-colors text-[11px] font-bold">GIF</button>
              </div>
            </div>
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading} className="p-2 rounded-full text-muted-foreground hover:text-foreground transition-colors">
              {uploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Camera className="w-5 h-5" />}
            </button>
            <input ref={fileInputRef} type="file" accept="image/*,video/*" onChange={handleFileSelect} className="hidden" />
            {(newComment.trim() || attachedMedia) && (
              <button type="submit" disabled={createComment.isPending} className="p-2 rounded-full text-primary hover:text-primary/80 transition-colors">
                <Send className="w-5 h-5" />
              </button>
            )}
          </form>
        </div>
      )}
    </div>
  );
}

interface CommentItemProps {
  comment: Comment;
  isOwner: boolean;
  onDelete: () => void;
  onReply: () => void;
  postId: string;
  isReply?: boolean;
  parentName?: string;
}

function CommentItem({ comment, isOwner, onDelete, onReply, postId, isReply, parentName }: CommentItemProps) {
  const [translated, setTranslated] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const [reactionLock, setReactionLock] = useState(false);
  const likeComment = useLikeComment();
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const longPressTriggered = useRef(false);

  const { text, mediaUrl, isGif, isVideo, isImage } = parseCommentMedia(comment.body);

  const handleTranslate = async () => {
    if (translated) { setTranslated(null); return; }
    if (!text) return;
    setTranslating(true);
    try {
      const { supabase } = await import('@/integrations/supabase/client');
      const { data } = await supabase.functions.invoke('zeus', {
        body: { message: `Traduis ce texte en français (réponds UNIQUEMENT avec la traduction, rien d'autre) : "${text}"`, context: 'translation' }
      });
      if (data?.reply) setTranslated(data.reply);
    } catch {} finally { setTranslating(false); }
  };

  // Pick a specific reaction emoji: same emoji = remove, different = change
  const handlePickReaction = useCallback((type: ReactionType) => {
    if (reactionLock || likeComment.isPending) return;
    setReactionLock(true);
    setShowReactionPicker(false);

    if (comment.user_reaction === type) {
      likeComment.mutate(
        { commentId: comment.id, postId, action: 'remove' },
        { onSettled: () => setReactionLock(false) }
      );
    } else {
      likeComment.mutate(
        { commentId: comment.id, postId, action: 'add', reactionType: type },
        { onSettled: () => setReactionLock(false) }
      );
    }
  }, [comment.id, comment.user_reaction, postId, reactionLock, likeComment]);

  // Short tap on like button: toggle current reaction (or default to love)
  const handleLike = useCallback(() => {
    if (longPressTriggered.current) { longPressTriggered.current = false; return; }
    if (reactionLock || likeComment.isPending) return;
    if (showReactionPicker) { setShowReactionPicker(false); return; }
    const next: ReactionType = comment.user_reaction ?? 'love';
    handlePickReaction(next);
  }, [reactionLock, likeComment.isPending, showReactionPicker, comment.user_reaction, handlePickReaction]);

  const startLongPress = useCallback(() => {
    longPressTriggered.current = false;
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => {
      longPressTriggered.current = true;
      setShowReactionPicker(true);
    }, 400);
  }, []);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // Close picker when clicking outside
  useEffect(() => {
    if (!showReactionPicker) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowReactionPicker(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [showReactionPicker]);

  const reactionEmoji = comment.user_reaction ? REACTION_EMOJIS[comment.user_reaction] : null;

  const isZeus = !!comment.is_zeus_reply;

  return (
    <div className={cn("flex gap-2.5 py-1.5 animate-slide-up")}>
      {isZeus ? (
        <div className="flex-shrink-0 mt-0.5 w-8 h-8 rounded-full bg-gradient-to-br from-primary via-primary to-primary/70 flex items-center justify-center shadow-md shadow-primary/30 ring-2 ring-primary/20">
          <span className="text-base">⚡</span>
        </div>
      ) : (
        <Link to={`/profile/${comment.user_id}`} className="flex-shrink-0 mt-0.5">
          <UserAvatar src={comment.profile.avatar_url} alt={comment.profile.name} size="sm" />
        </Link>
      )}
      <div className="flex-1 min-w-0">
        <div className={cn(
          "inline-block rounded-2xl px-3 py-2 max-w-full",
          isZeus
            ? "bg-gradient-to-br from-primary/10 via-primary/5 to-transparent border border-primary/20 ring-1 ring-primary/10"
            : "bg-secondary/50"
        )}>
          <div className="flex items-center gap-1.5">
            {isZeus ? (
              <span className="font-semibold text-[13px] text-primary" style={{ fontFamily: 'Playfair Display, serif' }}>
                Zeus <span className="text-[10px] font-normal text-muted-foreground ml-1">Modération bienveillante</span>
              </span>
            ) : (
              <Link to={`/profile/${comment.user_id}`} className="font-semibold text-[13px] hover:underline">
                {comment.profile.name}
              </Link>
            )}
            {isReply && parentName && !isZeus && (
              <>
                <CornerDownRight className="w-3 h-3 text-muted-foreground" />
                <span className="text-[11px] text-primary font-medium">@{parentName}</span>
              </>
            )}
          </div>
          {text && (
            <p className="text-[13px] text-foreground break-words leading-[1.4] mt-0.5">{text}</p>
          )}
        </div>

        {mediaUrl && (
          <div className="mt-1.5 rounded-xl overflow-hidden inline-block max-w-[280px]">
            {isGif || isImage ? (
              <img src={mediaUrl} alt="" className="max-h-48 rounded-xl object-cover" loading="lazy" />
            ) : isVideo ? (
              <video src={mediaUrl} className="max-h-48 rounded-xl" controls preload="metadata" />
            ) : null}
          </div>
        )}

        {translated && (
          <div className="mt-1 px-3 py-1.5 bg-primary/5 rounded-xl inline-block">
            <p className="text-[12px] text-foreground italic">{translated}</p>
          </div>
        )}

        {/* Reaction picker for comments — Facebook style */}
        {showReactionPicker && (
          <div className="flex gap-0.5 mt-1 p-1 bg-card/95 backdrop-blur-xl rounded-full border border-border/30 shadow-lg inline-flex animate-slide-up">
            {(Object.keys(REACTION_EMOJIS) as ReactionType[]).map((type) => (
              <button
                key={type}
                onClick={() => handlePickReaction(type)}
                disabled={reactionLock || likeComment.isPending}
                className="w-8 h-8 flex items-center justify-center text-xl rounded-full hover:bg-secondary hover:scale-125 transition-all active:scale-90 disabled:opacity-50 disabled:pointer-events-none"
                title={REACTION_LABELS[type]}
              >
                {REACTION_EMOJIS[type]}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3 mt-1 px-1">
          <span className="text-[11px] text-muted-foreground">
            {formatDistanceToNow(new Date(comment.created_at), { addSuffix: false, locale: fr })}
          </span>
          <button
            onClick={handleLike}
            disabled={reactionLock || likeComment.isPending}
            className={cn(
              "text-[11px] font-semibold transition-colors",
              comment.is_liked ? "text-primary" : "text-muted-foreground hover:text-foreground",
              (reactionLock || likeComment.isPending) && "opacity-50 pointer-events-none"
            )}
          >
            {reactionEmoji ? reactionEmoji : "J'aime"}{comment.likes_count > 0 && ` · ${comment.likes_count}`}
          </button>
          <button onClick={onReply} className="text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors">
            Répondre
          </button>
          {text && (
            <button onClick={handleTranslate} disabled={translating} className="text-[11px] font-medium text-primary/70 hover:text-primary transition-colors">
              {translating ? <Loader2 className="w-3 h-3 animate-spin inline" /> : translated ? 'Original' : 'Traduire'}
            </button>
          )}
          {isOwner && (
            <button onClick={onDelete} className="text-muted-foreground hover:text-destructive transition-colors ml-auto">
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function parseCommentMedia(body: string) {
  let text = body;
  let mediaUrl: string | null = null;
  let isGif = false;
  let isVideo = false;
  let isImage = false;

  const gifMatch = text.match(/GIF:(https:\/\/[^\s]+)/i);
  if (gifMatch) {
    const sanitized = sanitizeUrl(gifMatch[1]);
    if (sanitized !== '#') { mediaUrl = sanitized; isGif = true; }
    text = text.replace(gifMatch[0], '').trim();
  }

  if (!mediaUrl) {
    const urlMatch = text.match(/(https:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|mp4|webm|mov))(\?[^\s]*)?/i);
    if (urlMatch) {
      const sanitized = sanitizeUrl(urlMatch[0]);
      if (sanitized !== '#') {
        mediaUrl = sanitized;
        const ext = urlMatch[2].toLowerCase();
        isVideo = ['mp4', 'webm', 'mov'].includes(ext);
        isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
        isGif = ext === 'gif';
      }
      text = text.replace(urlMatch[0], '').trim();
    }
  }

  return { text: text || null, mediaUrl, isGif, isVideo, isImage };
}
