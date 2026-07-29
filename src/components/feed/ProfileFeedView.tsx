import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { FeedProfileHeader } from '@/components/feed/FeedProfileHeader';
import { PostCard } from '@/components/PostCard';

/**
 * Vue "fiche profil" affichée en haut du fil quand on clique sur un ami/contact.
 * Style Instagram : carte profil centrée, puis les publications de la personne.
 */
export function ProfileFeedView({ userId }: { userId: string }) {
  const navigate = useNavigate();

  const { data: posts, isLoading } = useQuery({
    queryKey: ['profile-feed-posts', userId],
    enabled: !!userId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('posts')
        .select('id, user_id, body, image_url, created_at, likes_count, comments_count')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(30);
      if (error) throw error;

      const { data: profile } = await supabase
        .from('profiles')
        .select('name, avatar_url, mood_emoji')
        .eq('user_id', userId)
        .maybeSingle();

      return (data ?? []).map((p: any) => ({
        ...p,
        profile: {
          name: profile?.name ?? 'Utilisateur',
          avatar_url: profile?.avatar_url ?? null,
          mood_emoji: profile?.mood_emoji ?? null,
        },
        is_liked: false,
        user_reaction: null,
      }));
    },
  });

  return (
    <div className="space-y-4 pb-6">
      <div className="px-3 sm:px-4 pt-2">
        <button
          onClick={() => navigate('/feed')}
          className="inline-flex items-center gap-1.5 px-3 h-9 rounded-full bg-secondary/50 border border-border/30 text-xs hover:bg-secondary transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Retour au fil
        </button>
      </div>

      <FeedProfileHeader userId={userId} />

      <div className="sm:px-4 sm:space-y-4 mt-2">
        {isLoading ? (
          [1, 2].map((i) => (
            <div key={i} className="rounded-2xl overflow-hidden bg-card border border-border/30">
              <div className="p-4 flex gap-3">
                <div className="w-11 h-11 rounded-full skeleton" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-28 skeleton rounded-lg" />
                  <div className="h-3 w-16 skeleton rounded-lg" />
                </div>
              </div>
              <div className="h-64 skeleton" />
            </div>
          ))
        ) : (posts?.length ?? 0) === 0 ? (
          <div className="px-4">
            <div className="premium-card p-8 text-center text-sm text-muted-foreground">
              Aucune publication pour le moment.
            </div>
          </div>
        ) : (
          posts!.map((post: any) => <PostCard key={post.id} post={post} />)
        )}
      </div>
    </div>
  );
}
