import { useParams, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { AppLayout } from '@/components/AppLayout';
import { PostCard } from '@/components/PostCard';
import { CommentsList } from '@/components/CommentsList';
import { Button } from '@/components/ui/button';

export default function PostDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();

  const { data: post, isLoading } = useQuery({
    queryKey: ['post', id],
    queryFn: async () => {
      if (!id) throw new Error('No post ID');

      const { data: postData, error } = await supabase
        .from('posts')
        .select('id, user_id, body, image_url, created_at')
        .eq('id', id)
        .single();

      if (error) throw error;

      // Get profile
      const { data: profile } = await supabase
        .from('profiles')
        .select('name, avatar_url')
        .eq('user_id', postData.user_id)
        .single();

      // Get counts
      const [{ count: likesCount }, { count: commentsCount }, userLikeRes] = await Promise.all([
        supabase.from('likes').select('*', { count: 'exact', head: true }).eq('post_id', id),
        supabase.from('comments').select('*', { count: 'exact', head: true }).eq('post_id', id),
        user
          ? supabase.from('likes').select('id').eq('user_id', user.id).eq('post_id', id).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      return {
        id: postData.id,
        user_id: postData.user_id,
        body: postData.body,
        image_url: postData.image_url,
        created_at: postData.created_at,
        profile: {
          name: profile?.name || 'Unknown',
          avatar_url: profile?.avatar_url || null,
        },
        likes_count: likesCount || 0,
        comments_count: commentsCount || 0,
        is_liked: !!userLikeRes.data,
      };
    },
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <AppLayout>
        <div className="pulse-card p-5 animate-pulse">
          <div className="flex gap-3">
            <div className="w-10 h-10 rounded-full bg-muted" />
            <div className="flex-1 space-y-3">
              <div className="h-4 w-32 bg-muted rounded" />
              <div className="h-4 w-full bg-muted rounded" />
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!post) {
    return (
      <AppLayout>
        <div className="pulse-card p-8 text-center">
          <p className="text-muted-foreground">Post non trouvé</p>
          <Link to="/feed">
            <Button variant="ghost" className="mt-4">
              Retour au feed
            </Button>
          </Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <header className="flex items-center gap-3 mb-4">
        <Link to="/feed">
          <Button variant="ghost" size="icon" className="shrink-0">
            <ArrowLeft className="w-5 h-5" />
          </Button>
        </Link>
        <h1 className="text-lg font-semibold">Post</h1>
      </header>

      <div className="pulse-card overflow-hidden">
        <div className="p-4 sm:p-5">
          <PostCard post={post} showActions={true} />
        </div>
        
        <div className="border-t border-border/50">
          <h2 className="px-4 py-3 font-semibold text-sm text-muted-foreground">
            Commentaires
          </h2>
          <CommentsList postId={post.id} />
        </div>
      </div>
    </AppLayout>
  );
}
