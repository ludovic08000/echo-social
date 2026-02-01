import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Users, Lock, Globe, Search, ChevronRight } from 'lucide-react';
import { useGroups, useJoinGroup, useLeaveGroup } from '@/hooks/useGroups';
import { useAuth } from '@/lib/auth';
import { AppLayout } from '@/components/AppLayout';
import { CreateGroupDialog } from '@/components/settings/CreateGroupDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

export default function Groups() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: groups, isLoading } = useGroups();
  const joinGroup = useJoinGroup();
  const leaveGroup = useLeaveGroup();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('discover');

  const myGroups = groups?.filter(g => g.is_member) || [];
  const discoverGroups = groups?.filter(g => !g.is_member) || [];

  const filteredMyGroups = myGroups.filter(g =>
    g.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredDiscoverGroups = discoverGroups.filter(g =>
    g.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleJoin = async (groupId: string) => {
    try {
      await joinGroup.mutateAsync(groupId);
      toast({ title: 'Vous avez rejoint le groupe !' });
    } catch {
      toast({ title: 'Erreur', description: 'Impossible de rejoindre le groupe', variant: 'destructive' });
    }
  };

  const handleLeave = async (groupId: string) => {
    try {
      await leaveGroup.mutateAsync(groupId);
      toast({ title: 'Vous avez quitté le groupe' });
    } catch {
      toast({ title: 'Erreur', description: 'Impossible de quitter le groupe', variant: 'destructive' });
    }
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Groupes</h1>
          <CreateGroupDialog>
            <Button className="premium-button">
              <Plus className="w-4 h-4 mr-2" />
              Créer
            </Button>
          </CreateGroupDialog>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Rechercher des groupes..."
            className="pl-10 premium-input"
          />
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="w-full grid grid-cols-2 bg-secondary/50 p-1 rounded-xl">
            <TabsTrigger value="discover" className="rounded-lg data-[state=active]:bg-card data-[state=active]:shadow-sm">
              Découvrir
            </TabsTrigger>
            <TabsTrigger value="my-groups" className="rounded-lg data-[state=active]:bg-card data-[state=active]:shadow-sm">
              Mes groupes ({myGroups.length})
            </TabsTrigger>
          </TabsList>

          {/* Discover Tab */}
          <TabsContent value="discover" className="mt-4 space-y-3">
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className="flex items-center gap-3 p-4 rounded-xl bg-card">
                    <Skeleton className="w-16 h-16 rounded-xl" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-48" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredDiscoverGroups.length === 0 ? (
              <div className="text-center py-12">
                <Users className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground">
                  {searchQuery ? 'Aucun groupe trouvé' : 'Aucun groupe à découvrir pour le moment'}
                </p>
              </div>
            ) : (
              filteredDiscoverGroups.map(group => (
                <div
                  key={group.id}
                  className="flex items-start gap-4 p-4 rounded-xl bg-card hover:bg-card/80 transition-colors"
                >
                  {/* Group cover/icon */}
                  <div className="w-16 h-16 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                    {group.cover_image_url ? (
                      <img src={group.cover_image_url} alt={group.name} className="w-full h-full object-cover rounded-xl" />
                    ) : (
                      <Users className="w-8 h-8 text-primary" />
                    )}
                  </div>

                  {/* Group info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold truncate">{group.name}</h3>
                      {group.privacy === 'private' ? (
                        <Lock className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      ) : (
                        <Globe className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      )}
                    </div>
                    {group.description && (
                      <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                        {group.description}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-2">
                      {group.member_count} membres • {group.privacy === 'public' ? 'Public' : 'Privé'}
                    </p>
                  </div>

                  {/* Join button */}
                  <Button
                    onClick={() => handleJoin(group.id)}
                    disabled={joinGroup.isPending}
                    size="sm"
                    className="flex-shrink-0"
                  >
                    Rejoindre
                  </Button>
                </div>
              ))
            )}
          </TabsContent>

          {/* My Groups Tab */}
          <TabsContent value="my-groups" className="mt-4 space-y-3">
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => (
                  <div key={i} className="flex items-center gap-3 p-4 rounded-xl bg-card">
                    <Skeleton className="w-14 h-14 rounded-xl" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredMyGroups.length === 0 ? (
              <div className="text-center py-12">
                <Users className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground mb-4">
                  {searchQuery ? 'Aucun groupe trouvé' : "Vous n'avez pas encore rejoint de groupe"}
                </p>
                <CreateGroupDialog>
                  <Button>
                    <Plus className="w-4 h-4 mr-2" />
                    Créer un groupe
                  </Button>
                </CreateGroupDialog>
              </div>
            ) : (
              filteredMyGroups.map(group => (
                <div
                  key={group.id}
                  className="flex items-center gap-4 p-4 rounded-xl bg-card hover:bg-card/80 transition-colors cursor-pointer group"
                >
                  {/* Group icon */}
                  <div className="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                    {group.cover_image_url ? (
                      <img src={group.cover_image_url} alt={group.name} className="w-full h-full object-cover rounded-xl" />
                    ) : (
                      <Users className="w-7 h-7 text-primary" />
                    )}
                  </div>

                  {/* Group info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold truncate">{group.name}</h3>
                      {group.privacy === 'private' ? (
                        <Lock className="w-3.5 h-3.5 text-muted-foreground" />
                      ) : (
                        <Globe className="w-3.5 h-3.5 text-muted-foreground" />
                      )}
                      {group.is_admin && (
                        <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                          Admin
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {group.member_count} membres
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
