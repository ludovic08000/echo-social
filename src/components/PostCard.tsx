import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { MessageCircle, Trash2, MoreHorizontal, ThumbsUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Post, useDeletePost } from '@/hooks/usePosts';
import { useAuth } from '@/lib/auth';
import { UserAvatar } from './UserAvatar';
import { Button } from '@/components/ui/button';
import { ReactionButton } from './ReactionButton';
import { cn } from '@/lib/utils';
import { ReactionType } from '@/hooks/useReactions';
import { ShareButton } from './ShareButton';
import { generatePostUrl } from '@/lib/urlUtils';
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

  const postUrl = generatePostUrl(post.id);

  const handleDelete = () => {
    if (confirm('Êtes-vous sûr de vouloir supprimer ce post ?')) {
      deletePost.mutate(post.id);
    }
  };

  const isOwner = user?.id === post.user_id;

  return (
    <article className="bg-card border-y border-border/30 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <div className="flex items-center gap-3">
          <Link to={`/profile/${post.user_id}`}>
            <UserAvatar src={post.profile.avatar_url} alt={post.profile.name} size="md" />
          </Link>
          
          <div className="min-w-0">
            <Link 
              to={`/profile/${post.user_id}`}
              className="font-semibold text-sm text-foreground hover:text-primary transition-colors block truncate"
            >
              {post.profile.name}
            </Link>
            <Link to={`/post/${post.id}`}>
              <span className="text-muted-foreground text-xs">
                {formatDistanceToNow(new Date(post.created_at), { addSuffix: true, locale: fr })}
              </span>
            </Link>
          </div>
        </div>
        
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground">
              <MoreHorizontal className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="rounded-xl">
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
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Content */}
      <Link to={`/post/${post.id}`}>
        {post.body && (
          <p className="px-4 pb-3 text-sm text-foreground whitespace-pre-wrap break-words leading-relaxed">
            {post.body}
          </p>
        )}
        
        {post.image_url && (
          <div className="w-full">
            <img
              src={post.image_url}
              alt="Post image"
              className="w-full object-cover max-h-[480px]"
            />
          </div>
        )}
      </Link>

      {/* Reactions Count */}
      {(post.likes_count > 0 || post.comments_count > 0) && (
        <div className="flex items-center justify-between px-4 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            {post.likes_count > 0 && (
              <>
                <div className="w-[18px] h-[18px] rounded-full bg-primary/90 flex items-center justify-center">
                  <ThumbsUp className="w-2.5 h-2.5 text-primary-foreground" />
                </div>
                <span>{post.likes_count}</span>
              </>
            )}
          </div>
          {post.comments_count > 0 && (
            <button onClick={onCommentClick} className="hover:text-foreground transition-colors">
              {post.comments_count} commentaire{post.comments_count > 1 ? 's' : ''}
            </button>
          )}
        </div>
      )}
      
      {/* Actions */}
      {showActions && (
        <div className="flex items-center border-t border-border/30 mx-4 py-1">
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
            className="flex-1 h-10 gap-2 text-muted-foreground hover:text-foreground hover:bg-secondary/60 rounded-xl text-xs"
          >
            <MessageCircle className="w-[18px] h-[18px]" />
            <span className="font-medium">Commenter</span>
          </Button>
          
          <ShareButton
            url={postUrl}
            title={`Post de ${post.profile.name}`}
            text={post.body?.slice(0, 100)}
            variant="ghost"
            size="sm"
            showLabel
            className="flex-1 h-10 gap-2 text-muted-foreground hover:text-foreground hover:bg-secondary/60 rounded-xl text-xs"
          />
        </div>
      )}
    </article>
  );
}
