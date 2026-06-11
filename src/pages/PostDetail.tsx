import { useEffect, useRef } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { ArrowLeft, MoreHorizontal } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { ReactionType } from '@/hooks/useReactions';
import { AppLayout } from '@/components/AppLayout';
import { PostCard } from '@/components/PostCard';
import { CommentsList } from '@/components/CommentsList';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/UserAvatar';
import { SEOHead } from '@/components/SEOHead';
import { buildPostMeta } from '@/lib/seo/buildMeta';

export default function PostDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const location = useLocation();
  const commentsRef = useRef<HTMLDivElement>(null);

  // Scroll to comments when #comments hash is present
  useEffect(() => {
    if (location.hash === '#comments' && commentsRef.current) {
      setTimeout(() => commentsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
    }
  }, [location.hash]);

  const { data: post, isLoading } = useQuery({
    queryKey: ['post', id],
    queryFn: async () => {
      if (!id) throw new Error('No post ID');

      const { data: postData, error } = await supabase
        .from('posts')
        .select('id, user_id, body, image_url, created_at, likes_count, comments_count')
        .eq('id', id)
        .single() as { data: any; error: any };

      if (error) throw error;

      const { data: profile } = await supabase
        .from('profiles')
        .select('name, avatar_url')
        .eq('user_id', postData.user_id)
        .single();

      const userLikeRes = user
        ? await supabase.from('likes').select('id, reaction_type').eq('user_id', user.id).eq('post_id', id).maybeSingle()
        : { data: null };

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
        likes_count: postData.likes_count || 0,
        comments_count: postData.comments_count || 0,
        is_liked: !!userLikeRes.data,
        user_reaction: (userLikeRes.data?.reaction_type as ReactionType) ?? null,
      };
    },
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <AppLayout>
        <div className="p-5 animate-pulse space-y-4">
          <div className="flex gap-3">
            <div className="w-10 h-10 rounded-full bg-muted" />
            <div className="flex-1 space-y-3">
              <div className="h-4 w-32 bg-muted rounded" />
              <div className="h-4 w-full bg-muted rounded" />
            </div>
          </div>
          <div className="h-64 bg-muted rounded-xl" />
        </div>
      </AppLayout>
    );
  }

  if (!post) {
    return (
      <AppLayout>
        <div className="p-8 text-center">
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

  const meta = buildPostMeta({
    postId: post.id,
    body: post.body,
    imageUrl: post.image_url,
    authorName: post.profile.name,
    createdAt: post.created_at,
  });

  return (
    <AppLayout>
      <SEOHead
        title={meta.title}
        description={meta.description}
        url={meta.url}
        image={meta.image}
        type="article"
        jsonLd={meta.jsonLd}
      />
      {/* Header — Facebook style */}
      <header className="flex items-center gap-3 px-3 py-2 border-b border-border/20 bg-card sticky top-12 z-30">
        <Link to="/feed">
          <Button variant="ghost" size="icon" className="shrink-0 h-9 w-9 rounded-full">
            <ArrowLeft className="w-5 h-5" />
          </Button>
        </Link>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <UserAvatar src={post.profile.avatar_url} alt={post.profile.name} size="sm" />
          <div className="min-w-0">
            <p className="text-[14px] font-semibold truncate">{post.profile.name}</p>
          </div>
        </div>
        <button className="h-9 w-9 rounded-full flex items-center justify-center text-muted-foreground hover:bg-secondary/50 transition-colors">
          <MoreHorizontal className="w-5 h-5" />
        </button>
      </header>

      {/* Post content */}
      <div className="bg-card">
        <PostCard post={post} showActions={true} onCommentClick={() => {
          commentsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }} />
      </div>
      
      {/* Comments section */}
      <div ref={commentsRef} className="bg-card border-t border-border/20">
        <CommentsList postId={post.id} />
      </div>
    </AppLayout>
  );
}
