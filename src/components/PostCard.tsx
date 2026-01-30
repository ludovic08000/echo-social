import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { MessageCircle, Share2, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Post, useDeletePost } from '@/hooks/usePosts';
import { useAuth } from '@/lib/auth';
import { UserAvatar } from './UserAvatar';
import { Button } from '@/components/ui/button';
import { ReactionButton } from './ReactionButton';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { ReactionType } from '@/hooks/useReactions';

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
    <article className="pulse-card p-4 sm:p-5 animate-fade-in">
      <div className="flex gap-3">
        <Link to={`/profile/${post.user_id}`}>
          <UserAvatar src={post.profile.avatar_url} alt={post.profile.name} size="md" />
        </Link>
        
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Link 
                to={`/profile/${post.user_id}`}
                className="font-semibold text-foreground hover:underline truncate"
              >
                {post.profile.name}
              </Link>
              <span className="text-muted-foreground text-sm shrink-0">
                · {formatDistanceToNow(new Date(post.created_at), { addSuffix: true, locale: fr })}
              </span>
            </div>
            
            {isOwner && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleDelete}
                className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
          </div>
          
          <Link to={`/post/${post.id}`}>
            <p className="mt-2 text-foreground whitespace-pre-wrap break-words">
              {post.body}
            </p>
            
            {post.image_url && (
              <div className="mt-3 rounded-xl overflow-hidden">
                <img
                  src={post.image_url}
                  alt="Post image"
                  className="w-full max-h-96 object-cover"
                />
              </div>
            )}
          </Link>
          
          {showActions && (
            <div className="flex items-center gap-1 mt-3 -ml-2">
              <ReactionButton 
                postId={post.id}
                currentReaction={post.user_reaction}
                reactionsCount={post.likes_count}
              />
              
              <Button
                variant="ghost"
                size="sm"
                onClick={onCommentClick}
                className="h-9 px-3 gap-2 text-muted-foreground hover:text-primary hover:bg-accent"
              >
                <MessageCircle className="w-4 h-4" />
                <span className="text-sm">{post.comments_count || ''}</span>
              </Button>
              
              <Button
                variant="ghost"
                size="sm"
                onClick={handleShare}
                className="h-9 px-3 text-muted-foreground hover:text-primary hover:bg-accent"
              >
                <Share2 className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
