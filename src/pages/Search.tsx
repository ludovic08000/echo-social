import { useState } from 'react';
import { Search as SearchIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { AppLayout } from '@/components/AppLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { PostCard } from '@/components/PostCard';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/lib/auth';
import { useNavigate } from 'react-router-dom';

export default function Search() {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('users');
  const { user } = useAuth();
  const navigate = useNavigate();

  const { data: users, isLoading: usersLoading } = useQuery({
    queryKey: ['search-users', query],
    queryFn: async () => {
      if (!query.trim()) return [];

      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url, bio')
        .ilike('name', `%${query}%`)
        .limit(20);

      if (error) throw error;
      return data;
    },
    enabled: query.length >= 2,
  });

  const { data: posts, isLoading: postsLoading } = useQuery({
    queryKey: ['search-posts', query],
    queryFn: async () => {
      if (!query.trim()) return [];

      const { data: postsData, error } = await supabase
        .from('posts')
        .select('id, user_id, body, image_url, created_at')
        .ilike('body', `%${query}%`)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) throw error;

      // Get profiles
      const userIds = [...new Set(postsData.map(p => p.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', userIds);

      const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);

      // Get likes counts
      const postIds = postsData.map(p => p.id);
      const [likesRes, commentsRes, userLikesRes] = await Promise.all([
        supabase.from('likes').select('post_id').in('post_id', postIds),
        supabase.from('comments').select('post_id').in('post_id', postIds),
        user 
          ? supabase.from('likes').select('post_id').eq('user_id', user.id).in('post_id', postIds)
          : Promise.resolve({ data: [] }),
      ]);

      const likesCount: Record<string, number> = {};
      const commentsCount: Record<string, number> = {};
      const userLikes = new Set(userLikesRes.data?.map(l => l.post_id) || []);

      likesRes.data?.forEach(l => {
        likesCount[l.post_id] = (likesCount[l.post_id] || 0) + 1;
      });
      commentsRes.data?.forEach(c => {
        commentsCount[c.post_id] = (commentsCount[c.post_id] || 0) + 1;
      });

      return postsData.map(post => {
        const profile = profileMap.get(post.user_id);
        return {
          id: post.id,
          user_id: post.user_id,
          body: post.body,
          image_url: post.image_url,
          created_at: post.created_at,
          profile: {
            name: profile?.name || 'Unknown',
            avatar_url: profile?.avatar_url || null,
          },
          likes_count: likesCount[post.id] || 0,
          comments_count: commentsCount[post.id] || 0,
          is_liked: userLikes.has(post.id),
        };
      });
    },
    enabled: query.length >= 2,
  });

  return (
    <AppLayout>
      <header className="mb-6">
        <h1 className="text-xl font-bold mb-4">Rechercher</h1>
        
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher des utilisateurs ou des posts..."
            className="pulse-input pl-10"
          />
        </div>
      </header>

      {query.length >= 2 ? (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-full mb-4">
            <TabsTrigger value="users" className="flex-1">
              Utilisateurs {users?.length ? `(${users.length})` : ''}
            </TabsTrigger>
            <TabsTrigger value="posts" className="flex-1">
              Posts {posts?.length ? `(${posts.length})` : ''}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="users">
            {usersLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="pulse-card p-4 animate-pulse">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-muted" />
                      <div className="h-4 w-32 bg-muted rounded" />
                    </div>
                  </div>
                ))}
              </div>
            ) : users?.length === 0 ? (
              <div className="pulse-card p-8 text-center">
                <p className="text-muted-foreground">Aucun utilisateur trouvé</p>
              </div>
            ) : (
              <div className="space-y-2">
                {users?.map((u) => (
                  <Link key={u.user_id} to={`/profile/${u.user_id}`}>
                    <div className="pulse-card p-4 flex items-center gap-3 hover:bg-secondary/50 transition-colors">
                      <UserAvatar src={u.avatar_url} alt={u.name} size="md" />
                      <div>
                        <p className="font-medium">{u.name}</p>
                        {u.bio && (
                          <p className="text-sm text-muted-foreground line-clamp-1">{u.bio}</p>
                        )}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="posts">
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
                <p className="text-muted-foreground">Aucun post trouvé</p>
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
          </TabsContent>
        </Tabs>
      ) : (
        <div className="pulse-card p-8 text-center">
          <p className="text-muted-foreground">
            Tapez au moins 2 caractères pour rechercher
          </p>
        </div>
      )}
    </AppLayout>
  );
}
