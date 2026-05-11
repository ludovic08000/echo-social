import { useState } from 'react';
import { Users, Clock, UserCheck, UserPlus, Search, UserX, MessageCircle, Sparkles, MapPin } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { useFriendships, useRespondToFriendRequest, useRemoveFriend, useSendFriendRequest } from '@/hooks/useFriendships';
import { useCreateConversation } from '@/hooks/useMessages';
import { useAuth } from '@/lib/auth';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/hooks/use-toast';
import { InviteContacts } from '@/components/InviteContacts';
import { FriendSuggestions } from '@/components/feed/FriendSuggestions';
import { Badge } from '@/components/ui/badge';
import { useNewUsers } from '@/hooks/useNewUsers';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';

export default function Friends() {
  const { data, isLoading } = useFriendships();
  const respondToRequest = useRespondToFriendRequest();
  const removeFriend = useRemoveFriend();
  const sendRequest = useSendFriendRequest();
  const createConversation = useCreateConversation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const [searchQuery, setSearchQuery] = useState('');
  const { data: newUsers, isLoading: loadingNewUsers } = useNewUsers();
  const tabParam = searchParams.get('tab');
  const defaultTab = tabParam === 'followers' || tabParam === 'following' ? 'friends' : (tabParam || 'new');
  const [friendSubTab, setFriendSubTab] = useState<'all' | 'followers' | 'following'>(
    tabParam === 'followers' ? 'followers' : tabParam === 'following' ? 'following' : 'all'
  );

  const handleAccept = (friendshipId: string) => {
    respondToRequest.mutate(
      { friendshipId, accept: true },
      { onSuccess: () => toast({ title: '🎉 Ami ajouté !' }) }
    );
  };

  const handleReject = (friendshipId: string) => {
    respondToRequest.mutate({ friendshipId, accept: false });
  };

  const handleRemove = (friendshipId: string) => {
    if (confirm('Retirer cet ami ?')) {
      removeFriend.mutate(friendshipId);
    }
  };

  const handleMessage = async (userId: string) => {
    const conv = await createConversation.mutateAsync(userId);
    navigate(`/messages/${conv.id}`);
  };

  const filteredFriends = data?.friends.filter(f =>
    f.profile.name.toLowerCase().includes(searchQuery.toLowerCase())
  ) || [];

  const requestCount = data?.requests.length || 0;

  return (
    <AppLayout>
      <header className="mb-5">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" />
            Amis
          </h1>
          <Link to="/friend-match">
            <Button variant="outline" size="sm" className="rounded-xl gap-1.5 text-xs">
              <UserPlus className="w-3.5 h-3.5" />
              Découvrir
            </Button>
          </Link>
        </div>
      </header>

      <Tabs defaultValue="new" className="w-full">
        <TabsList className="grid w-full grid-cols-5 rounded-xl h-10">
          <TabsTrigger value="new" className="gap-1.5 text-xs rounded-lg data-[state=active]:shadow-sm">
            <Sparkles className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Nouveaux</span>
          </TabsTrigger>
          <TabsTrigger value="friends" className="gap-1.5 text-xs rounded-lg data-[state=active]:shadow-sm">
            <Users className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Amis</span>
            {data?.friends.length ? (
              <span className="text-[10px] font-medium text-muted-foreground">{data.friends.length}</span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="requests" className="gap-1.5 text-xs rounded-lg data-[state=active]:shadow-sm relative">
            <UserCheck className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Demandes</span>
            {requestCount > 0 && (
              <Badge variant="destructive" className="absolute -top-1 -right-1 h-4 w-4 p-0 flex items-center justify-center text-[9px] rounded-full">
                {requestCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="pending" className="gap-1.5 text-xs rounded-lg data-[state=active]:shadow-sm">
            <Clock className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Envoyées</span>
          </TabsTrigger>
          <TabsTrigger value="invite" className="gap-1.5 text-xs rounded-lg data-[state=active]:shadow-sm">
            <UserPlus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Inviter</span>
          </TabsTrigger>
        </TabsList>

        {/* New Users Tab */}
        <TabsContent value="new" className="mt-4">
          <div className="rounded-2xl border border-border/30 bg-card overflow-hidden divide-y divide-border/20">
            {loadingNewUsers ? (
              <LoadingSkeleton />
            ) : !newUsers?.length ? (
              <EmptyState
                icon={<Sparkles className="w-10 h-10 text-muted-foreground/40" />}
                message="Aucun nouveau membre"
              />
            ) : (
              newUsers.map(u => (
                <div key={u.user_id} className="flex items-center gap-3 p-3 hover:bg-secondary/20 transition-colors">
                  <Link to={`/profile/${u.user_id}`} className="flex-shrink-0">
                    <UserAvatar src={u.avatar_url} alt={u.name} size="md" />
                  </Link>
                  <Link to={`/profile/${u.user_id}`} className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{u.name}</p>
                    <div className="flex items-center gap-2">
                      <p className="text-[11px] text-muted-foreground">
                        Inscrit {formatDistanceToNow(new Date(u.created_at), { addSuffix: true, locale: fr })}
                      </p>
                      {u.city && (
                        <span className="text-[10px] text-primary flex items-center gap-0.5">
                          <MapPin className="w-3 h-3" />
                          {u.city}
                        </span>
                      )}
                    </div>
                  </Link>
                  <Button
                    size="sm"
                    className="rounded-xl h-8 text-xs gap-1.5"
                    onClick={() => sendRequest.mutate(u.user_id)}
                    disabled={sendRequest.isPending}
                  >
                    <UserPlus className="w-3.5 h-3.5" />
                    Ajouter
                  </Button>
                </div>
              ))
            )}
          </div>
        </TabsContent>

        {/* Friends Tab */}
        <TabsContent value="friends" className="mt-4 space-y-4">
          {(data?.friends.length ?? 0) > 5 && (
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Rechercher un ami..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="pl-9 rounded-xl h-10 bg-secondary/30 border-border/30"
              />
            </div>
          )}

          <div className="rounded-2xl border border-border/30 bg-card overflow-hidden divide-y divide-border/20">
            {isLoading ? (
              <LoadingSkeleton />
            ) : filteredFriends.length === 0 ? (
              <EmptyState
                icon={<Users className="w-10 h-10 text-muted-foreground/40" />}
                message={searchQuery ? 'Aucun résultat' : 'Aucun ami pour le moment'}
                sub={!searchQuery ? 'Découvre des personnes à ajouter !' : undefined}
              />
            ) : (
              filteredFriends.map(friendship => (
                <div key={friendship.id} className="flex items-center gap-3 p-3 hover:bg-secondary/20 transition-colors">
                  <Link to={`/profile/${friendship.profile.user_id}`} className="flex-shrink-0">
                    <UserAvatar src={friendship.profile.avatar_url} alt={friendship.profile.name} size="md" />
                  </Link>
                  <Link to={`/profile/${friendship.profile.user_id}`} className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{friendship.profile.name}</p>
                  </Link>
                  <div className="flex gap-1.5 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 rounded-xl text-muted-foreground hover:text-primary hover:bg-primary/10"
                      onClick={() => handleMessage(friendship.profile.user_id)}
                    >
                      <MessageCircle className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 rounded-xl text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      onClick={() => handleRemove(friendship.id)}
                    >
                      <UserX className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>

          <FriendSuggestions />
        </TabsContent>

        {/* Requests Tab */}
        <TabsContent value="requests" className="mt-4">
          <div className="rounded-2xl border border-border/30 bg-card overflow-hidden divide-y divide-border/20">
            {isLoading ? (
              <LoadingSkeleton />
            ) : data?.requests.length === 0 ? (
              <EmptyState
                icon={<UserCheck className="w-10 h-10 text-muted-foreground/40" />}
                message="Aucune demande d'ami"
              />
            ) : (
              data?.requests.map(friendship => (
                <div key={friendship.id} className="p-3">
                  <div className="flex items-center gap-3">
                    <Link to={`/profile/${friendship.profile.user_id}`} className="flex-shrink-0">
                      <UserAvatar src={friendship.profile.avatar_url} alt={friendship.profile.name} size="md" />
                    </Link>
                    <div className="flex-1 min-w-0">
                      <Link to={`/profile/${friendship.profile.user_id}`}>
                        <p className="font-medium text-sm truncate">{friendship.profile.name}</p>
                      </Link>
                      <p className="text-[11px] text-muted-foreground">souhaite être votre ami</p>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-2.5 ml-[52px]">
                    <Button
                      size="sm"
                      onClick={() => handleAccept(friendship.id)}
                      disabled={respondToRequest.isPending}
                      className="flex-1 rounded-xl h-9 text-xs active:scale-95 transition-all"
                    >
                      Accepter
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleReject(friendship.id)}
                      disabled={respondToRequest.isPending}
                      className="flex-1 rounded-xl h-9 text-xs"
                    >
                      Refuser
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </TabsContent>

        {/* Pending Tab */}
        <TabsContent value="pending" className="mt-4">
          <div className="rounded-2xl border border-border/30 bg-card overflow-hidden divide-y divide-border/20">
            {isLoading ? (
              <LoadingSkeleton />
            ) : data?.pending.length === 0 ? (
              <EmptyState
                icon={<Clock className="w-10 h-10 text-muted-foreground/40" />}
                message="Aucune demande envoyée"
              />
            ) : (
              data?.pending.map(friendship => (
                <div key={friendship.id} className="flex items-center gap-3 p-3 hover:bg-secondary/20 transition-colors">
                  <Link to={`/profile/${friendship.profile.user_id}`} className="flex-shrink-0">
                    <UserAvatar src={friendship.profile.avatar_url} alt={friendship.profile.name} size="md" />
                  </Link>
                  <Link to={`/profile/${friendship.profile.user_id}`} className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{friendship.profile.name}</p>
                  </Link>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemove(friendship.id)}
                    className="text-xs text-muted-foreground hover:text-destructive rounded-xl gap-1.5"
                  >
                    <UserX className="w-3.5 h-3.5" />
                    Annuler
                  </Button>
                </div>
              ))
            )}
          </div>
        </TabsContent>

        {/* Invite Tab — unified: share + sync + import */}
        <TabsContent value="invite" className="mt-4">
          <div className="rounded-2xl border border-border/30 bg-card overflow-hidden min-h-[300px]">
            <InviteContacts />
          </div>
        </TabsContent>
      </Tabs>
    </AppLayout>
  );
}

function LoadingSkeleton() {
  return (
    <div className="p-3 space-y-3">
      {[1, 2, 3, 4].map(i => (
        <div key={i} className="flex items-center gap-3 animate-pulse">
          <div className="w-10 h-10 rounded-full bg-muted" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-28 bg-muted rounded-lg" />
            <div className="h-2.5 w-20 bg-muted/60 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, message, sub }: { icon: React.ReactNode; message: string; sub?: string }) {
  return (
    <div className="p-10 text-center">
      <div className="mx-auto mb-3">{icon}</div>
      <p className="text-sm font-medium text-muted-foreground">{message}</p>
      {sub && <p className="text-xs text-muted-foreground/60 mt-1">{sub}</p>}
    </div>
  );
}
