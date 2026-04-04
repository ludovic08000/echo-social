import { useState, useRef } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { Trash2, Send, Smile, Camera, Image as ImageIcon, Languages, Loader2, ChevronDown, ThumbsUp } from 'lucide-react';
import { useComments, useCreateComment, useDeleteComment, Comment } from '@/hooks/useComments';
import { useAuth } from '@/lib/auth';
import { UserAvatar } from './UserAvatar';
import { Button } from '@/components/ui/button';
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

const COMMENT_EMOJIS = [
  '😀','😂','🤣','😍','🥰','😘','🤩','😎','🥳','🤗',
  '🔥','❤️','💯','👏','🙌','💪','✨','🎉','👍','👎',
  '💀','😭','😱','🤯','😏','🥺','😡','🤬','🤝','💜',
  '💙','💚','💛','🧡','⚡','🌟','💎','🏆','🎯','🫶',
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
  const [attachedMedia, setAttachedMedia] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<'image' | 'gif' | 'video' | null>(null);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { upload } = useR2Upload({ folder: 'images', maxSizeMB: 20 });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
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
      { postId, body },
      {
        onSuccess: () => {
          setNewComment('');
          setAttachedMedia(null);
          setMediaType(null);
        },
      }
    );
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const isVideo = file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');
    if (!isVideo && !isImage) {
      toast.error('Format non supporté. Utilisez une image ou vidéo.');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast.error('Fichier trop volumineux (max 20 Mo)');
      return;
    }

    setUploading(true);
    try {
      const url = await upload(file, 'comments');
      setAttachedMedia(url);
      setMediaType(isVideo ? 'video' : 'image');
    } catch {
      toast.error("Erreur lors de l'upload");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleGifSelect = (gifUrl: string) => {
    setAttachedMedia(gifUrl);
    setMediaType('gif');
    setShowGifPicker(false);
  };

  const handleDelete = (commentId: string) => {
    deleteComment.mutate({ commentId, postId });
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
      {/* Sort header */}
      <button className="flex items-center gap-1 px-4 py-2.5 text-[14px] font-semibold text-foreground">
        Plus pertinents
        <ChevronDown className="w-4 h-4" />
      </button>

      {/* Comments list */}
      <div className="px-4 pb-4 space-y-4 max-h-[60vh] overflow-y-auto">
        {comments?.length === 0 ? (
          <p className="text-muted-foreground text-center py-6 text-sm">
            Aucun commentaire pour le moment
          </p>
        ) : (
          comments?.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              isOwner={user?.id === comment.user_id}
              onDelete={() => handleDelete(comment.id)}
            />
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
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* GIF Picker */}
      {showGifPicker && (
        <div className="px-4 pb-2">
          <GifPicker onSelect={handleGifSelect} onClose={() => setShowGifPicker(false)} />
        </div>
      )}

      {/* Comment input bar — Facebook style */}
      {user && (
        <div className="flex items-center gap-2 px-3 py-2.5 border-t border-border/30 bg-card">
          <UserAvatar size="sm" />
          
          <form onSubmit={handleSubmit} className="flex-1 flex items-center gap-1.5">
            <div className="flex-1 relative">
              <input
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Commentez..."
                className="w-full bg-secondary/50 rounded-full px-4 py-2 pr-24 text-[13px] outline-none placeholder:text-muted-foreground focus:bg-secondary/70 transition-colors"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                <Popover>
                  <PopoverTrigger asChild>
                    <button type="button" className="p-1 rounded-full text-muted-foreground hover:text-foreground transition-colors">
                      <Smile className="w-4 h-4" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent side="top" align="end" className="w-64 p-2 rounded-xl" sideOffset={8}>
                    <div className="grid grid-cols-8 gap-1">
                      {COMMENT_EMOJIS.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => setNewComment(prev => prev + emoji)}
                          className="w-7 h-7 flex items-center justify-center text-lg hover:bg-secondary rounded transition-colors"
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>

                <button
                  type="button"
                  onClick={() => setShowGifPicker(!showGifPicker)}
                  className="p-1 rounded-full text-muted-foreground hover:text-foreground transition-colors text-[11px] font-bold"
                >
                  GIF
                </button>
              </div>
            </div>

            {/* Camera / media button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="p-2 rounded-full text-muted-foreground hover:text-foreground transition-colors"
            >
              {uploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Camera className="w-5 h-5" />}
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*"
              onChange={handleFileSelect}
              className="hidden"
            />

            {(newComment.trim() || attachedMedia) && (
              <button
                type="submit"
                disabled={createComment.isPending}
                className="p-2 rounded-full text-primary hover:text-primary/80 transition-colors"
              >
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
}

function CommentItem({ comment, isOwner, onDelete }: CommentItemProps) {
  const [translated, setTranslated] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);

  // Parse media from comment body
  const { text, mediaUrl, isGif, isVideo, isImage } = parseCommentMedia(comment.body);

  const handleTranslate = async () => {
    if (translated) { setTranslated(null); return; }
    if (!text) return;
    setTranslating(true);
    try {
      const { supabase } = await import('@/integrations/supabase/client');
      const { data } = await supabase.functions.invoke('zeus', {
        body: { 
          message: `Traduis ce texte en français (réponds UNIQUEMENT avec la traduction, rien d'autre) : "${text}"`,
          context: 'translation'
        }
      });
      if (data?.reply) setTranslated(data.reply);
    } catch {
      // silent fail
    } finally {
      setTranslating(false);
    }
  };

  return (
    <div className="flex gap-2.5 animate-slide-up">
      <Link to={`/profile/${comment.user_id}`} className="flex-shrink-0 mt-0.5">
        <UserAvatar src={comment.profile.avatar_url} alt={comment.profile.name} size="sm" />
      </Link>
      
      <div className="flex-1 min-w-0">
        {/* Comment bubble */}
        <div className="inline-block bg-secondary/50 rounded-2xl px-3 py-2 max-w-full">
          <Link 
            to={`/profile/${comment.user_id}`}
            className="font-semibold text-[13px] hover:underline block"
          >
            {comment.profile.name}
          </Link>
          {text && (
            <p className="text-[13px] text-foreground break-words leading-[1.4] mt-0.5">
              {text}
            </p>
          )}
        </div>

        {/* Media attachment */}
        {mediaUrl && (
          <div className="mt-1.5 rounded-xl overflow-hidden inline-block max-w-[280px]">
            {isGif || isImage ? (
              <img src={mediaUrl} alt="" className="max-h-48 rounded-xl object-cover" loading="lazy" />
            ) : isVideo ? (
              <video src={mediaUrl} className="max-h-48 rounded-xl" controls preload="metadata" />
            ) : null}
          </div>
        )}

        {/* Translated text */}
        {translated && (
          <div className="mt-1 px-3 py-1.5 bg-primary/5 rounded-xl inline-block">
            <p className="text-[12px] text-foreground italic">{translated}</p>
          </div>
        )}

        {/* Actions row */}
        <div className="flex items-center gap-3 mt-1 px-1">
          <span className="text-[11px] text-muted-foreground">
            {formatDistanceToNow(new Date(comment.created_at), { addSuffix: false, locale: fr })}
          </span>
          <button className="text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors">
            J'aime
          </button>
          <button className="text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors">
            Répondre
          </button>
          {text && (
            <button 
              onClick={handleTranslate}
              disabled={translating}
              className="text-[11px] font-medium text-primary/70 hover:text-primary transition-colors"
            >
              {translating ? <Loader2 className="w-3 h-3 animate-spin inline" /> : translated ? 'Original' : 'Voir la traduction'}
            </button>
          )}
          {isOwner && (
            <button
              onClick={onDelete}
              className="text-muted-foreground hover:text-destructive transition-colors ml-auto"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Parse media URLs and GIF markers from comment body */
function parseCommentMedia(body: string) {
  let text = body;
  let mediaUrl: string | null = null;
  let isGif = false;
  let isVideo = false;
  let isImage = false;

  // GIF:url
  const gifMatch = text.match(/GIF:(https?:\/\/[^\s]+)/i);
  if (gifMatch) {
    mediaUrl = gifMatch[1];
    isGif = true;
    text = text.replace(gifMatch[0], '').trim();
  }

  // Direct media URL on its own line
  if (!mediaUrl) {
    const urlMatch = text.match(/(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|mp4|webm|mov))(\?[^\s]*)?/i);
    if (urlMatch) {
      mediaUrl = urlMatch[0];
      const ext = urlMatch[2].toLowerCase();
      isVideo = ['mp4', 'webm', 'mov'].includes(ext);
      isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
      isGif = ext === 'gif';
      text = text.replace(urlMatch[0], '').trim();
    }
  }

  return { text: text || null, mediaUrl, isGif, isVideo, isImage };
}
