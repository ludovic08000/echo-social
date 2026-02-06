import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Building2, Heart, Globe, Phone, Mail, MapPin, Users2 } from 'lucide-react';
import { AppLayout } from '@/components/AppLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePage, useFollowPage, useUnfollowPage } from '@/hooks/usePages';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/hooks/use-toast';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';

const CATEGORY_LABELS: Record<string, string> = {
  business: 'Entreprise',
  brand: 'Marque',
  artist: 'Artiste',
  community: 'Communauté',
  entertainment: 'Divertissement',
  sports: 'Sports',
  news: 'Actualités',
  education: 'Éducation',
  nonprofit: 'Association',
  general: 'Autre',
};

function usePagePosts(pageId: string) {
  return useQuery({
    queryKey: ['page-posts', pageId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('page_posts')
        .select('*')
        .eq('page_id', pageId)
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
    enabled: !!pageId,
  });
}

function useCreatePagePost() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ pageId, body }: { pageId: string; body: string }) => {
      if (!user) throw new Error('Not authenticated');
      const { data, error } = await supabase
        .from('page_posts')
        .insert({ page_id: pageId, user_id: user.id, body })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['page-posts', vars.pageId] });
    },
  });
}

export default function PageDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: page, isLoading } = usePage(id || '');
  const { data: posts } = usePagePosts(id || '');
  const followPage = useFollowPage();
  const unfollowPage = useUnfollowPage();
  const createPost = useCreatePagePost();
  const [newPost, setNewPost] = useState('');

  const handlePost = async () => {
    if (!newPost.trim() || !id) return;
    try {
      await createPost.mutateAsync({ pageId: id, body: newPost.trim() });
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

  if (!page) {
    return (
      <AppLayout>
        <div className="text-center py-16">
          <p className="text-muted-foreground">Page introuvable</p>
          <Link to="/pages">
            <Button variant="ghost" className="mt-4">Retour aux pages</Button>
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
          <Link to="/pages">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <h1 className="text-xl font-bold truncate">{page.name}</h1>
        </div>

        {/* Cover */}
        <div className="relative h-40 rounded-xl bg-gradient-to-br from-primary/20 to-accent/20 overflow-hidden">
          {page.cover_image_url ? (
            <img src={page.cover_image_url} alt={page.name} className="w-full h-full object-cover" />
          ) : (
            <div className="flex items-center justify-center h-full">
              <Building2 className="w-16 h-16 text-primary/30" />
            </div>
          )}
          {/* Profile image overlay */}
          <div className="absolute -bottom-8 left-4">
            <div className="w-20 h-20 rounded-full bg-card border-4 border-background overflow-hidden flex items-center justify-center">
              {page.profile_image_url ? (
                <img src={page.profile_image_url} alt={page.name} className="w-full h-full object-cover" />
              ) : (
                <Building2 className="w-8 h-8 text-primary" />
              )}
            </div>
          </div>
        </div>

        {/* Info */}
        <div className="pt-6 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold">{page.name}</h2>
              <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                <span>{CATEGORY_LABELS[page.category] || page.category}</span>
                <span>•</span>
                <span className="flex items-center gap-1">
                  <Users2 className="w-3.5 h-3.5" />
                  {page.follower_count} abonnés
                </span>
              </div>
            </div>

            {page.is_admin ? (
              <Button variant="outline" disabled>
                Admin
              </Button>
            ) : page.is_following ? (
              <Button
                variant="outline"
                onClick={() => id && unfollowPage.mutate(id)}
                disabled={unfollowPage.isPending}
              >
                Ne plus suivre
              </Button>
            ) : (
              <Button
                onClick={() => id && followPage.mutate(id)}
                disabled={followPage.isPending}
                className="premium-button"
              >
                <Heart className="w-4 h-4 mr-1" />
                Suivre
              </Button>
            )}
          </div>

          {page.description && (
            <p className="text-muted-foreground">{page.description}</p>
          )}

          {/* Contact info */}
          {(page.website_url || page.phone || page.email || page.address) && (
            <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
              {page.website_url && (
                <a href={page.website_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:text-primary transition-colors">
                  <Globe className="w-4 h-4" /> Site web
                </a>
              )}
              {page.phone && (
                <a href={`tel:${page.phone}`} className="flex items-center gap-1 hover:text-primary transition-colors">
                  <Phone className="w-4 h-4" /> {page.phone}
                </a>
              )}
              {page.email && (
                <a href={`mailto:${page.email}`} className="flex items-center gap-1 hover:text-primary transition-colors">
                  <Mail className="w-4 h-4" /> {page.email}
                </a>
              )}
              {page.address && (
                <span className="flex items-center gap-1">
                  <MapPin className="w-4 h-4" /> {page.address}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Posts */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">Publications</h3>

          {/* Create post (admin only) */}
          {page.is_admin && (
            <div className="pulse-card p-4 space-y-3">
              <Textarea
                value={newPost}
                onChange={e => setNewPost(e.target.value)}
                placeholder="Publier en tant que cette page..."
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
              Aucune publication sur cette page
            </div>
          ) : (
            posts?.map(post => (
              <div key={post.id} className="pulse-card p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden">
                    {page.profile_image_url ? (
                      <img src={page.profile_image_url} alt={page.name} className="w-full h-full object-cover" />
                    ) : (
                      <Building2 className="w-5 h-5 text-primary" />
                    )}
                  </div>
                  <div>
                    <span className="font-semibold">{page.name}</span>
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
        </div>
      </div>
    </AppLayout>
  );
}
