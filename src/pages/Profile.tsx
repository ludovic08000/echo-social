import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Edit2 } from 'lucide-react';
import { useProfile, useUpdateProfile } from '@/hooks/useProfile';
import { useUserPosts } from '@/hooks/usePosts';
import { useAuth } from '@/lib/auth';
import { AppLayout } from '@/components/AppLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { PostCard } from '@/components/PostCard';
import { Button } from '@/components/ui/button';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useNavigate } from 'react-router-dom';

export default function Profile() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  
  const userId = id || user?.id;
  const isOwnProfile = userId === user?.id;

  const { data: profile, isLoading: profileLoading } = useProfile(userId);
  const { data: posts, isLoading: postsLoading } = useUserPosts(userId || '');

  // Get stats
  const { data: stats } = useQuery({
    queryKey: ['profile-stats', userId],
    queryFn: async () => {
      if (!userId) return { postsCount: 0, likesReceived: 0 };

      const [{ count: postsCount }, { data: postIds }] = await Promise.all([
        supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', userId),
        supabase.from('posts').select('id').eq('user_id', userId),
      ]);

      let likesReceived = 0;
      if (postIds && postIds.length > 0) {
        const { count } = await supabase
          .from('likes')
          .select('*', { count: 'exact', head: true })
          .in('post_id', postIds.map(p => p.id));
        likesReceived = count || 0;
      }

      return { postsCount: postsCount || 0, likesReceived };
    },
    enabled: !!userId,
  });

  if (profileLoading) {
    return (
      <AppLayout>
        <div className="pulse-card p-6 animate-pulse">
          <div className="flex items-center gap-4">
            <div className="w-20 h-20 rounded-full bg-muted" />
            <div className="space-y-2">
              <div className="h-6 w-32 bg-muted rounded" />
              <div className="h-4 w-48 bg-muted rounded" />
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!profile) {
    return (
      <AppLayout>
        <div className="pulse-card p-8 text-center">
          <p className="text-muted-foreground">Profil non trouvé</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      {!isOwnProfile && (
        <header className="flex items-center gap-3 mb-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-lg font-semibold">{profile.name}</h1>
        </header>
      )}

      <div className="pulse-card p-6 mb-6">
        <div className="flex items-start gap-4">
          <UserAvatar src={profile.avatar_url} alt={profile.name} size="xl" />
          
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xl font-bold truncate">{profile.name}</h2>
              {isOwnProfile && (
                <Link to="/settings">
                  <Button variant="outline" size="sm" className="shrink-0">
                    <Edit2 className="w-4 h-4 mr-2" />
                    Modifier
                  </Button>
                </Link>
              )}
            </div>
            
            {profile.bio && (
              <p className="mt-2 text-muted-foreground">{profile.bio}</p>
            )}
            
            <div className="flex items-center gap-6 mt-4">
              <div className="text-center">
                <p className="text-xl font-bold">{stats?.postsCount || 0}</p>
                <p className="text-sm text-muted-foreground">Posts</p>
              </div>
              <div className="text-center">
                <p className="text-xl font-bold">{stats?.likesReceived || 0}</p>
                <p className="text-sm text-muted-foreground">Likes</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <h3 className="font-semibold text-muted-foreground mb-4">Publications</h3>

      {postsLoading ? (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="pulse-card p-5 animate-pulse">
              <div className="h-4 w-full bg-muted rounded" />
              <div className="h-4 w-2/3 bg-muted rounded mt-2" />
            </div>
          ))}
        </div>
      ) : posts?.length === 0 ? (
        <div className="pulse-card p-8 text-center">
          <p className="text-muted-foreground">
            {isOwnProfile ? "Vous n'avez pas encore publié." : 'Aucune publication.'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {posts?.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              onCommentClick={() => navigate(`/post/${post.id}`)}
            />
          ))}
        </div>
      )}
    </AppLayout>
  );
}
