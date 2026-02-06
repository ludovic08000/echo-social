import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Users, Lock, Globe, Plus, Image, Settings } from 'lucide-react';
import { AppLayout } from '@/components/AppLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useGroup, useGroupMembers, useJoinGroup, useLeaveGroup } from '@/hooks/useGroups';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/hooks/use-toast';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';

function useGroupPosts(groupId: string) {
  return useQuery({
    queryKey: ['group-posts', groupId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('group_posts')
        .select('*')
        .eq('group_id', groupId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const userIds = [...new Set(data.map(p => p.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', userIds);

      const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);

      return data.map(post => ({
        ...post,
        profile: profileMap.get(post.user_id) || { name: 'Inconnu', avatar_url: null },
      }));
    },
    enabled: !!groupId,
  });
}

function useCreateGroupPost() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ groupId, body }: { groupId: string; body: string }) => {
      if (!user) throw new Error('Not authenticated');
      const { data, error } = await supabase
        .from('group_posts')
        .insert({ group_id: groupId, user_id: user.id, body })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['group-posts', vars.groupId] });
    },
  });
}

export default function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { data: group, isLoading } = useGroup(id || '');
  const { data: members } = useGroupMembers(id || '');
  const { data: posts } = useGroupPosts(id || '');
  const joinGroup = useJoinGroup();
  const leaveGroup = useLeaveGroup();
  const createPost = useCreateGroupPost();
  const [newPost, setNewPost] = useState('');

  const handlePost = async () => {
    if (!newPost.trim() || !id) return;
    try {
      await createPost.mutateAsync({ groupId: id, body: newPost.trim() });
      setNewPost('');
      toast({ title: 'Publication ajoutée !' });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  if (isLoading) {
    return (
      <AppLayout>
        <div className="space-y-4">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      </AppLayout>
    );
  }

  if (!group) {
    return (
      <AppLayout>
        <div className="text-center py-16">
          <p className="text-muted-foreground">Groupe introuvable</p>
          <Link to="/groups">
            <Button variant="ghost" className="mt-4">Retour aux groupes</Button>
          </Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link to="/groups">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <h1 className="text-xl font-bold truncate">{group.name}</h1>
        </div>

        {/* Cover */}
        <div className="relative h-40 rounded-xl bg-gradient-to-br from-primary/20 to-accent/20 overflow-hidden">
          {group.cover_image_url ? (
            <img src={group.cover_image_url} alt={group.name} className="w-full h-full object-cover" />
          ) : (
            <div className="flex items-center justify-center h-full">
              <Users className="w-16 h-16 text-primary/30" />
            </div>
          )}
        </div>

        {/* Info */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold">{group.name}</h2>
              <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                {group.privacy === 'private' ? (
                  <><Lock className="w-4 h-4" /> Groupe privé</>
                ) : (
                  <><Globe className="w-4 h-4" /> Groupe public</>
                )}
                <span>•</span>
                <span>{group.member_count} membres</span>
              </div>
            </div>

            {group.is_member ? (
              <Button
                variant="outline"
                onClick={() => id && leaveGroup.mutate(id)}
                disabled={leaveGroup.isPending || group.is_admin}
              >
                {group.is_admin ? 'Admin' : 'Quitter'}
              </Button>
            ) : (
              <Button
                onClick={() => id && joinGroup.mutate(id)}
                disabled={joinGroup.isPending}
                className="premium-button"
              >
                Rejoindre
              </Button>
            )}
          </div>

          {group.description && (
            <p className="text-muted-foreground">{group.description}</p>
          )}
        </div>

        {/* Tabs */}
        <Tabs defaultValue="posts">
          <TabsList className="w-full grid grid-cols-2 bg-secondary/50 p-1 rounded-xl">
            <TabsTrigger value="posts" className="rounded-lg data-[state=active]:bg-card">
              Publications
            </TabsTrigger>
            <TabsTrigger value="members" className="rounded-lg data-[state=active]:bg-card">
              Membres ({members?.length || 0})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="posts" className="mt-4 space-y-4">
            {/* Create post */}
            {group.is_member && (
              <div className="pulse-card p-4 space-y-3">
                <Textarea
                  value={newPost}
                  onChange={e => setNewPost(e.target.value)}
                  placeholder="Écrire quelque chose..."
                  className="premium-input min-h-[80px] resize-none"
                />
                <div className="flex justify-end">
                  <Button
                    onClick={handlePost}
                    disabled={!newPost.trim() || createPost.isPending}
                    size="sm"
                  >
                    Publier
                  </Button>
                </div>
              </div>
            )}

            {posts?.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                Aucune publication dans ce groupe
              </div>
            ) : (
              posts?.map(post => (
                <div key={post.id} className="pulse-card p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <Link to={`/profile/${post.user_id}`}>
                      <UserAvatar src={post.profile.avatar_url} alt={post.profile.name} size="md" />
                    </Link>
                    <div>
                      <Link to={`/profile/${post.user_id}`} className="font-semibold hover:underline">
                        {post.profile.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(post.created_at), { addSuffix: true, locale: fr })}
                      </p>
                    </div>
                  </div>
                  <p className="whitespace-pre-wrap">{post.body}</p>
                  {post.image_url && (
                    <img src={post.image_url} alt="" className="rounded-xl max-h-96 w-full object-cover" />
                  )}
                </div>
              ))
            )}
          </TabsContent>

          <TabsContent value="members" className="mt-4 space-y-2">
            {members?.map(member => (
              <Link
                key={member.id}
                to={`/profile/${member.user_id}`}
                className="flex items-center gap-3 p-3 rounded-xl hover:bg-secondary/50 transition-colors"
              >
                <UserAvatar src={member.profile?.avatar_url} alt={member.profile?.name} size="md" />
                <div className="flex-1">
                  <span className="font-medium">{member.profile?.name || 'Inconnu'}</span>
                  {member.role === 'admin' && (
                    <span className="ml-2 text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                      Admin
                    </span>
                  )}
                </div>
              </Link>
            ))}
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
