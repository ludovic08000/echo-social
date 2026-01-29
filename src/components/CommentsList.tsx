import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { Trash2, Send } from 'lucide-react';
import { useComments, useCreateComment, useDeleteComment, Comment } from '@/hooks/useComments';
import { useAuth } from '@/lib/auth';
import { UserAvatar } from './UserAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Link } from 'react-router-dom';

interface CommentsListProps {
  postId: string;
}

export function CommentsList({ postId }: CommentsListProps) {
  const { user } = useAuth();
  const { data: comments, isLoading } = useComments(postId);
  const createComment = useCreateComment();
  const deleteComment = useDeleteComment();
  const [newComment, setNewComment] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim() || !user) return;

    createComment.mutate(
      { postId, body: newComment.trim() },
      {
        onSuccess: () => setNewComment(''),
      }
    );
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
    <div className="space-y-4">
      {user && (
        <form onSubmit={handleSubmit} className="flex gap-3 p-4 border-b border-border/50">
          <UserAvatar size="sm" />
          <div className="flex-1 flex gap-2">
            <Input
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder="Ajouter un commentaire..."
              className="pulse-input flex-1"
            />
            <Button
              type="submit"
              size="icon"
              disabled={!newComment.trim() || createComment.isPending}
              className="shrink-0 bg-primary hover:bg-primary/90"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </form>
      )}

      <div className="px-4 pb-4 space-y-4">
        {comments?.length === 0 ? (
          <p className="text-muted-foreground text-center py-6">
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
    </div>
  );
}

interface CommentItemProps {
  comment: Comment;
  isOwner: boolean;
  onDelete: () => void;
}

function CommentItem({ comment, isOwner, onDelete }: CommentItemProps) {
  return (
    <div className="flex gap-3 animate-slide-up">
      <Link to={`/profile/${comment.user_id}`}>
        <UserAvatar src={comment.profile.avatar_url} alt={comment.profile.name} size="sm" />
      </Link>
      
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Link 
            to={`/profile/${comment.user_id}`}
            className="font-medium text-sm hover:underline"
          >
            {comment.profile.name}
          </Link>
          <span className="text-xs text-muted-foreground">
            {formatDistanceToNow(new Date(comment.created_at), { addSuffix: true, locale: fr })}
          </span>
          
          {isOwner && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onDelete}
              className="h-6 w-6 ml-auto text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          )}
        </div>
        
        <p className="mt-1 text-sm text-foreground break-words">
          {comment.body}
        </p>
      </div>
    </div>
  );
}
