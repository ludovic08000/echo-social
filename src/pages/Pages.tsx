import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, FileText, Search, ChevronRight, Building2, Heart, Users2 } from 'lucide-react';
import { usePages, useFollowPage, useUnfollowPage } from '@/hooks/usePages';
import { useAuth } from '@/lib/auth';
import { AppLayout } from '@/components/AppLayout';
import { CreatePageDialog } from '@/components/settings/CreatePageDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';

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

export default function Pages() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: pages, isLoading } = usePages();
  const followPage = useFollowPage();
  const unfollowPage = useUnfollowPage();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('discover');

  const myPages = pages?.filter(p => p.is_admin) || [];
  const followedPages = pages?.filter(p => p.is_following && !p.is_admin) || [];
  const discoverPages = pages?.filter(p => !p.is_following && !p.is_admin) || [];

  const filteredDiscoverPages = discoverPages.filter(p =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredMyPages = myPages.filter(p =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredFollowedPages = followedPages.filter(p =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleFollow = async (pageId: string) => {
    try {
      await followPage.mutateAsync(pageId);
      toast({ title: 'Page suivie !' });
    } catch {
      toast({ title: 'Erreur', description: 'Impossible de suivre la page', variant: 'destructive' });
    }
  };

  const handleUnfollow = async (pageId: string) => {
    try {
      await unfollowPage.mutateAsync(pageId);
      toast({ title: 'Vous ne suivez plus cette page' });
    } catch {
      toast({ title: 'Erreur', description: 'Impossible de ne plus suivre', variant: 'destructive' });
    }
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Pages</h1>
          <CreatePageDialog>
            <Button className="premium-button">
              <Plus className="w-4 h-4 mr-2" />
              Créer
            </Button>
          </CreatePageDialog>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Rechercher des pages..."
            className="pl-10 premium-input"
          />
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="w-full grid grid-cols-3 bg-secondary/50 p-1 rounded-xl">
            <TabsTrigger value="discover" className="rounded-lg data-[state=active]:bg-card data-[state=active]:shadow-sm text-xs sm:text-sm">
              Découvrir
            </TabsTrigger>
            <TabsTrigger value="following" className="rounded-lg data-[state=active]:bg-card data-[state=active]:shadow-sm text-xs sm:text-sm">
              Suivies ({followedPages.length})
            </TabsTrigger>
            <TabsTrigger value="my-pages" className="rounded-lg data-[state=active]:bg-card data-[state=active]:shadow-sm text-xs sm:text-sm">
              Mes pages ({myPages.length})
            </TabsTrigger>
          </TabsList>

          {/* Discover Tab */}
          <TabsContent value="discover" className="mt-4 space-y-3">
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className="flex items-center gap-3 p-4 rounded-xl bg-card">
                    <Skeleton className="w-14 h-14 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-48" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredDiscoverPages.length === 0 ? (
              <div className="text-center py-12">
                <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground">
                  {searchQuery ? 'Aucune page trouvée' : 'Aucune page à découvrir pour le moment'}
                </p>
              </div>
            ) : (
              filteredDiscoverPages.map(page => (
                <div
                  key={page.id}
                  className="flex items-start gap-4 p-4 rounded-xl bg-card hover:bg-card/80 transition-colors"
                >
                  {/* Page avatar */}
                  <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {page.profile_image_url ? (
                      <img src={page.profile_image_url} alt={page.name} className="w-full h-full object-cover" />
                    ) : (
                      <Building2 className="w-7 h-7 text-primary" />
                    )}
                  </div>

                  {/* Page info */}
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold truncate">{page.name}</h3>
                    <p className="text-sm text-muted-foreground">
                      {CATEGORY_LABELS[page.category] || page.category}
                    </p>
                    {page.description && (
                      <p className="text-sm text-muted-foreground line-clamp-1 mt-1">
                        {page.description}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                      <Users2 className="w-3 h-3" />
                      {page.follower_count} abonnés
                    </p>
                  </div>

                  {/* Follow button */}
                  <Button
                    onClick={() => handleFollow(page.id)}
                    disabled={followPage.isPending}
                    size="sm"
                    className="flex-shrink-0"
                  >
                    <Heart className="w-4 h-4 mr-1" />
                    Suivre
                  </Button>
                </div>
              ))
            )}
          </TabsContent>

          {/* Following Tab */}
          <TabsContent value="following" className="mt-4 space-y-3">
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => (
                  <div key={i} className="flex items-center gap-3 p-4 rounded-xl bg-card">
                    <Skeleton className="w-12 h-12 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredFollowedPages.length === 0 ? (
              <div className="text-center py-12">
                <Heart className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground">
                  {searchQuery ? 'Aucune page trouvée' : "Vous ne suivez pas encore de page"}
                </p>
              </div>
            ) : (
              filteredFollowedPages.map(page => (
                <div
                  key={page.id}
                  className="flex items-center gap-4 p-4 rounded-xl bg-card hover:bg-card/80 transition-colors cursor-pointer group"
                >
                  <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {page.profile_image_url ? (
                      <img src={page.profile_image_url} alt={page.name} className="w-full h-full object-cover" />
                    ) : (
                      <Building2 className="w-6 h-6 text-primary" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold truncate">{page.name}</h3>
                    <p className="text-sm text-muted-foreground">
                      {CATEGORY_LABELS[page.category] || page.category}
                    </p>
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleUnfollow(page.id)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    Ne plus suivre
                  </Button>
                </div>
              ))
            )}
          </TabsContent>

          {/* My Pages Tab */}
          <TabsContent value="my-pages" className="mt-4 space-y-3">
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2].map(i => (
                  <div key={i} className="flex items-center gap-3 p-4 rounded-xl bg-card">
                    <Skeleton className="w-12 h-12 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredMyPages.length === 0 ? (
              <div className="text-center py-12">
                <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground mb-4">
                  {searchQuery ? 'Aucune page trouvée' : "Vous n'avez pas encore créé de page"}
                </p>
                <CreatePageDialog>
                  <Button>
                    <Plus className="w-4 h-4 mr-2" />
                    Créer une page
                  </Button>
                </CreatePageDialog>
              </div>
            ) : (
              filteredMyPages.map(page => (
                <div
                  key={page.id}
                  className="flex items-center gap-4 p-4 rounded-xl bg-card hover:bg-card/80 transition-colors cursor-pointer group"
                >
                  <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {page.profile_image_url ? (
                      <img src={page.profile_image_url} alt={page.name} className="w-full h-full object-cover" />
                    ) : (
                      <Building2 className="w-6 h-6 text-primary" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold truncate">{page.name}</h3>
                      <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                        Admin
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {page.follower_count} abonnés
                    </p>
                  </div>

                  <ChevronRight className="w-5 h-5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              ))
            )}
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
