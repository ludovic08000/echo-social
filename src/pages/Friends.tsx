import { Users, Clock, UserCheck, UserPlus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { useFriendships, useRespondToFriendRequest, useRemoveFriend } from '@/hooks/useFriendships';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/hooks/use-toast';
import { InviteContacts } from '@/components/InviteContacts';

export default function Friends() {
  const { data, isLoading } = useFriendships();
  const respondToRequest = useRespondToFriendRequest();
  const removeFriend = useRemoveFriend();

  const handleAccept = (friendshipId: string) => {
    respondToRequest.mutate(
      { friendshipId, accept: true },
      { onSuccess: () => toast({ title: 'Ami ajouté !' }) }
    );
  };

  const handleReject = (friendshipId: string) => {
    respondToRequest.mutate(
      { friendshipId, accept: false },
      { onSuccess: () => toast({ title: 'Demande refusée' }) }
    );
  };

  const handleRemove = (friendshipId: string) => {
    if (confirm('Retirer cet ami ?')) {
      removeFriend.mutate(friendshipId);
    }
  };

  return (
    <AppLayout>
      <header className="mb-6">
        <h1 className="text-xl font-bold">Amis</h1>
      </header>

      <Tabs defaultValue="friends" className="w-full">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="friends" className="gap-1 text-xs sm:text-sm">
            <Users className="w-4 h-4" />
            <span className="hidden sm:inline">Amis</span>
            {data?.friends.length ? ` (${data.friends.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="requests" className="gap-1 text-xs sm:text-sm">
            <UserCheck className="w-4 h-4" />
            <span className="hidden sm:inline">Demandes</span>
            {data?.requests.length ? ` (${data.requests.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="pending" className="gap-1 text-xs sm:text-sm">
            <Clock className="w-4 h-4" />
            <span className="hidden sm:inline">En attente</span>
            {data?.pending.length ? ` (${data.pending.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="invite" className="gap-1 text-xs sm:text-sm">
            <UserPlus className="w-4 h-4" />
            <span className="hidden sm:inline">Inviter</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="friends" className="mt-4">
          <div className="pulse-card divide-y divide-border overflow-hidden">
            {isLoading ? (
              <LoadingSkeleton />
            ) : data?.friends.length === 0 ? (
              <EmptyState message="Aucun ami pour le moment" />
            ) : (
              data?.friends.map(friendship => (
                <div key={friendship.id} className="flex items-center justify-between p-4">
                  <Link 
                    to={`/profile/${friendship.profile.user_id}`}
                    className="flex items-center gap-3 hover:opacity-80"
                  >
                    <UserAvatar
                      src={friendship.profile.avatar_url}
                      alt={friendship.profile.name}
                      size="md"
                    />
                    <span className="font-medium">{friendship.profile.name}</span>
                  </Link>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRemove(friendship.id)}
                  >
                    Retirer
                  </Button>
                </div>
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="requests" className="mt-4">
          <div className="pulse-card divide-y divide-border overflow-hidden">
            {isLoading ? (
              <LoadingSkeleton />
            ) : data?.requests.length === 0 ? (
              <EmptyState message="Aucune demande d'ami" />
            ) : (
              data?.requests.map(friendship => (
                <div key={friendship.id} className="flex items-center justify-between p-4">
                  <Link 
                    to={`/profile/${friendship.profile.user_id}`}
                    className="flex items-center gap-3 hover:opacity-80"
                  >
                    <UserAvatar
                      src={friendship.profile.avatar_url}
                      alt={friendship.profile.name}
                      size="md"
                    />
                    <span className="font-medium">{friendship.profile.name}</span>
                  </Link>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => handleAccept(friendship.id)}
                      disabled={respondToRequest.isPending}
                    >
                      Accepter
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleReject(friendship.id)}
                      disabled={respondToRequest.isPending}
                    >
                      Refuser
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="pending" className="mt-4">
          <div className="pulse-card divide-y divide-border overflow-hidden">
            {isLoading ? (
              <LoadingSkeleton />
            ) : data?.pending.length === 0 ? (
              <EmptyState message="Aucune demande en attente" />
            ) : (
              data?.pending.map(friendship => (
                <div key={friendship.id} className="flex items-center justify-between p-4">
                  <Link 
                    to={`/profile/${friendship.profile.user_id}`}
                    className="flex items-center gap-3 hover:opacity-80"
                  >
                    <UserAvatar
                      src={friendship.profile.avatar_url}
                      alt={friendship.profile.name}
                      size="md"
                    />
                    <span className="font-medium">{friendship.profile.name}</span>
                  </Link>
                  <span className="text-sm text-muted-foreground flex items-center gap-2">
                    <Clock className="w-4 h-4" />
                    En attente
                  </span>
                </div>
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="invite" className="mt-4">
          <div className="pulse-card overflow-hidden min-h-[300px]">
            <InviteContacts />
          </div>
        </TabsContent>
      </Tabs>
    </AppLayout>
  );
}

function LoadingSkeleton() {
  return (
    <div className="p-4 space-y-4">
      {[1, 2, 3].map(i => (
        <div key={i} className="flex items-center gap-3 animate-pulse">
          <div className="w-10 h-10 rounded-full bg-muted" />
          <div className="h-4 w-32 bg-muted rounded" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="p-8 text-center text-muted-foreground">
      {message}
    </div>
  );
}
