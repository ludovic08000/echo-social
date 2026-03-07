import { Link } from 'react-router-dom';
import { MessageCircle, Search, Users, UserPlus, Check, X } from 'lucide-react';
import { useFriendships, useRespondToFriendRequest } from '@/hooks/useFriendships';
import { useConversations } from '@/hooks/useMessages';
import { UserAvatar } from '@/components/UserAvatar';
import { useAuth } from '@/lib/auth';
import { useState, useMemo } from 'react';
import { useScreenSize } from '@/hooks/useScreenSize';
import { useChatWidget } from '@/components/ChatWidgetContext';
import { useOnlinePresence } from '@/hooks/useOnlinePresence';
import { cn } from '@/lib/utils';

export function FeedRightSidebar() {
  const { user } = useAuth();
  const { data: friendships } = useFriendships();
  const { data: conversations } = useConversations();
  const [search, setSearch] = useState('');
  const { isDesktop } = useScreenSize();
  const { openConversation } = useChatWidget();
  const { isOnline } = useOnlinePresence();
  const respondToRequest = useRespondToFriendRequest();

  const friends = friendships?.friends || [];
  const requests = friendships?.requests || [];

  // Sort: online friends first
  const sortedFriends = useMemo(() => {
    return [...friends].sort((a, b) => {
      const aOnline = isOnline(a.profile.user_id) ? 1 : 0;
      const bOnline = isOnline(b.profile.user_id) ? 1 : 0;
      return bOnline - aOnline;
    });
  }, [friends, isOnline]);

  const filteredFriends = useMemo(() => {
    if (!search.trim()) return sortedFriends;
    return sortedFriends.filter(f =>
      f.profile.name.toLowerCase().includes(search.toLowerCase())
    );
  }, [sortedFriends, search]);

  const onlineFriendsCount = useMemo(() =>
    friends.filter(f => isOnline(f.profile.user_id)).length
  , [friends, isOnline]);

  const handleMessage = (friendUserId: string) => {
    if (!user) return;
    const existing = conversations?.find(c =>
      c.participant?.user_id === friendUserId
    );
    if (existing) {
      openConversation(existing.id);
    } else {
      openConversation('');
    }
  };

  if (!user || !isDesktop) return null;

  return (
    <aside className="hidden lg:block w-[280px] flex-shrink-0">
      <div className="sticky top-16 space-y-4 pl-2 max-h-[calc(100vh-80px)] overflow-y-auto scrollbar-thin">

        {/* New friend requests with accept/reject */}
        {requests.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between px-2">
              <div className="flex items-center gap-2">
                <div className="relative">
                  <UserPlus className="w-4 h-4 text-primary" />
                  <span className="absolute -top-1 -right-1.5 w-3.5 h-3.5 rounded-full bg-primary text-primary-foreground text-[8px] font-bold flex items-center justify-center">
                    {requests.length}
                  </span>
                </div>
                <h3 className="text-sm font-semibold text-foreground ml-1">Demandes d'amis</h3>
              </div>
              <Link to="/friends" className="text-xs text-primary font-medium hover:underline">
                Tout voir
              </Link>
            </div>
            <div className="space-y-1">
              {requests.slice(0, 4).map((req) => (
                <div
                  key={req.id}
                  className="px-3 py-2.5 rounded-xl hover:bg-secondary/40 transition-all duration-200"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="relative flex-shrink-0">
                      <UserAvatar src={req.profile.avatar_url} alt={req.profile.name} size="sm" />
                      <div className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-primary border-2 border-background" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{req.profile.name}</p>
                      <p className="text-[10px] text-muted-foreground">Veut être votre ami</p>
                    </div>
                  </div>
                  {/* Accept / Reject buttons */}
                  <div className="flex gap-2 mt-2 pl-10">
                    <button
                      onClick={() => respondToRequest.mutate({ friendshipId: req.id, accept: true })}
                      disabled={respondToRequest.isPending}
                      className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-all active:scale-95"
                    >
                      <Check className="w-3.5 h-3.5" />
                      Accepter
                    </button>
                    <button
                      onClick={() => respondToRequest.mutate({ friendshipId: req.id, accept: false })}
                      disabled={respondToRequest.isPending}
                      className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-secondary text-muted-foreground text-xs font-medium hover:bg-destructive/10 hover:text-destructive transition-all active:scale-95"
                    >
                      <X className="w-3.5 h-3.5" />
                      Refuser
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="premium-divider" />
          </div>
        )}

        {/* Contacts with online status */}
        <div className="space-y-2">
          <div className="flex items-center justify-between px-2">
            <h3 className="text-sm font-semibold text-foreground">Contacts</h3>
            <span className="text-xs text-muted-foreground">
              {onlineFriendsCount > 0 && (
                <span className="text-primary font-medium">{onlineFriendsCount} en ligne · </span>
              )}
              {friends.length} ami{friends.length > 1 ? 's' : ''}
            </span>
          </div>

          {/* Search contacts */}
          {friends.length > 5 && (
            <div className="px-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Rechercher un ami..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-sm rounded-xl bg-secondary/60 border-0 outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/60 transition-all"
                />
              </div>
            </div>
          )}

          {/* Friends list */}
          <div className="space-y-0.5">
            {filteredFriends.length === 0 ? (
              <div className="px-3 py-6 text-center">
                {friends.length === 0 ? (
                  <div className="space-y-2">
                    <Users className="w-8 h-8 text-muted-foreground/40 mx-auto" />
                    <p className="text-sm text-muted-foreground">Aucun ami pour le moment</p>
                    <Link to="/friends" className="text-xs text-primary font-medium hover:underline">
                      Trouver des amis
                    </Link>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Aucun résultat</p>
                )}
              </div>
            ) : (
              filteredFriends.map((friend) => {
                const online = isOnline(friend.profile.user_id);
                return (
                  <div
                    key={friend.id}
                    className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-secondary/60 transition-all duration-200 group cursor-pointer"
                    onClick={() => handleMessage(friend.profile.user_id)}
                  >
                    <div className="relative flex-shrink-0">
                      <UserAvatar src={friend.profile.avatar_url} alt={friend.profile.name} size="sm" />
                      <div className={cn(
                        'absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-background transition-colors',
                        online ? 'bg-primary' : 'bg-muted-foreground/30'
                      )} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium truncate block">{friend.profile.name}</span>
                      {online && (
                        <span className="text-[10px] text-primary font-medium">En ligne</span>
                      )}
                    </div>
                    <button
                      className="opacity-0 group-hover:opacity-100 w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-muted-foreground hover:text-primary transition-all duration-200"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMessage(friend.profile.user_id);
                      }}
                      title="Envoyer un message"
                    >
                      <MessageCircle className="w-4 h-4" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
