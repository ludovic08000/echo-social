import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { MessageCircle, Share2, Trash2, MoreHorizontal, ThumbsUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Post, useDeletePost } from '@/hooks/usePosts';
import { useAuth } from '@/lib/auth';
import { UserAvatar } from './UserAvatar';
import { Button } from '@/components/ui/button';
import { ReactionButton } from './ReactionButton';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { ReactionType } from '@/hooks/useReactions';
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

export function PostCard({ post, showActions = true, onCommentClick }: PostCardProps) {
  const { user } = useAuth();
  const deletePost = useDeletePost();

  const handleShare = async () => {
    const url = `${window.location.origin}/post/${post.id}`;
    await navigator.clipboard.writeText(url);
    toast({
      title: 'Lien copié !',
      description: 'Le lien du post a été copié dans le presse-papier',
    });
  };

  const handleDelete = () => {
    if (confirm('Êtes-vous sûr de vouloir supprimer ce post ?')) {
      deletePost.mutate(post.id);
    }
  };

  const isOwner = user?.id === post.user_id;

  return (
    <article className="bg-card border-y border-border/50 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between p-4 pb-3">
        <div className="flex items-center gap-3">
          <Link to={`/profile/${post.user_id}`}>
            <UserAvatar src={post.profile.avatar_url} alt={post.profile.name} size="md" />
          </Link>
          
          <div>
            <Link 
              to={`/profile/${post.user_id}`}
              className="font-semibold text-foreground hover:underline block"
            >
              {post.profile.name}
            </Link>
            <Link to={`/post/${post.id}`}>
              <span className="text-muted-foreground text-sm">
                {formatDistanceToNow(new Date(post.created_at), { addSuffix: true, locale: fr })}
              </span>
            </Link>
          </div>
        </div>
        
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground">
              <MoreHorizontal className="w-5 h-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleShare}>
              <Share2 className="w-4 h-4 mr-2" />
              Partager
            </DropdownMenuItem>
            {isOwner && (
              <DropdownMenuItem onClick={handleDelete} className="text-destructive">
                <Trash2 className="w-4 h-4 mr-2" />
                Supprimer
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Content */}
      <Link to={`/post/${post.id}`}>
        {post.body && (
          <p className="px-4 pb-3 text-foreground whitespace-pre-wrap break-words">
            {post.body}
          </p>
        )}
        
        {post.image_url && (
          <div className="w-full">
            <img
              src={post.image_url}
              alt="Post image"
              className="w-full object-cover max-h-[500px]"
            />
          </div>
        )}
      </Link>

      {/* Reactions Count */}
      {(post.likes_count > 0 || post.comments_count > 0) && (
        <div className="flex items-center justify-between px-4 py-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-1">
            {post.likes_count > 0 && (
              <>
                <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                  <ThumbsUp className="w-3 h-3 text-primary-foreground" />
                </div>
                <span>{post.likes_count}</span>
              </>
            )}
          </div>
          {post.comments_count > 0 && (
            <button onClick={onCommentClick} className="hover:underline">
              {post.comments_count} commentaire{post.comments_count > 1 ? 's' : ''}
            </button>
          )}
        </div>
      )}
      
      {/* Actions */}
      {showActions && (
        <div className="flex items-center justify-around border-t border-border/50 px-2 py-1">
          <ReactionButton 
            postId={post.id}
            currentReaction={post.user_reaction}
            reactionsCount={0}
            variant="facebook"
          />
          
          <Button
            variant="ghost"
            size="sm"
            onClick={onCommentClick}
            className="flex-1 h-11 gap-2 text-muted-foreground hover:bg-secondary rounded-lg"
          >
            <MessageCircle className="w-5 h-5" />
            <span className="text-sm font-medium">Commenter</span>
          </Button>
          
          <Button
            variant="ghost"
            size="sm"
            onClick={handleShare}
            className="flex-1 h-11 gap-2 text-muted-foreground hover:bg-secondary rounded-lg"
          >
            <Share2 className="w-5 h-5" />
            <span className="text-sm font-medium">Partager</span>
          </Button>
        </div>
      )}
    </article>
  );
}
