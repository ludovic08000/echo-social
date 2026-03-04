import { Link, useNavigate } from 'react-router-dom';
import { MessageCircle, Search, Users } from 'lucide-react';
import { useFriendships } from '@/hooks/useFriendships';
import { useConversations } from '@/hooks/useMessages';
import { UserAvatar } from '@/components/UserAvatar';
import { useAuth } from '@/lib/auth';
import { useState, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useScreenSize } from '@/hooks/useScreenSize';

export function FeedRightSidebar() {
  const { user } = useAuth();
  const { data: friendships } = useFriendships();
  const { data: conversations } = useConversations();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const { isDesktop } = useScreenSize();

  const friends = friendships?.friends || [];
  const requests = friendships?.requests || [];

  const filteredFriends = useMemo(() => {
    if (!search.trim()) return friends;
    return friends.filter(f => 
      f.profile.name.toLowerCase().includes(search.toLowerCase())
    );
  }, [friends, search]);

  const handleMessage = async (friendUserId: string) => {
    if (!user) return;

    // Check if conversation exists
    const existing = conversations?.find(c => 
      c.participant?.user_id === friendUserId
    );

    if (existing) {
      navigate(`/messages/${existing.id}`);
      return;
    }

    // Create new conversation without selecting it first
    const conversationId = crypto.randomUUID();

    const { error: convError } = await supabase
      .from('conversations')
      .insert({ id: conversationId });

    if (convError) return;

    const { error: partError } = await supabase.from('conversation_participants').insert([
      { conversation_id: conversationId, user_id: user.id },
      { conversation_id: conversationId, user_id: friendUserId },
    ]);

    if (partError) return;

    navigate(`/messages/${conversationId}`);
  };

  if (!user || !isDesktop) return null;

  return (
    <aside className="hidden lg:block w-[280px] flex-shrink-0">
      <div className="sticky top-16 space-y-4 pl-2 max-h-[calc(100vh-80px)] overflow-y-auto scrollbar-thin">
        
        {/* Friend requests */}
        {requests.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between px-2">
              <h3 className="text-sm font-semibold text-foreground">Demandes d'amis</h3>
              <Link to="/friends" className="text-xs text-primary font-medium hover:underline">
                Tout voir
              </Link>
            </div>
            <div className="space-y-1">
              {requests.slice(0, 3).map((req) => (
                <Link
                  key={req.id}
                  to="/friends"
                  className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-secondary/60 transition-all duration-200"
                >
                  <UserAvatar src={req.profile.avatar_url} alt={req.profile.name} size="sm" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{req.profile.name}</p>
                    <p className="text-xs text-muted-foreground">Demande en attente</p>
                  </div>
                  <div className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
                </Link>
              ))}
            </div>
            <div className="premium-divider" />
          </div>
        )}

        {/* Contacts */}
        <div className="space-y-2">
          <div className="flex items-center justify-between px-2">
            <h3 className="text-sm font-semibold text-foreground">Contacts</h3>
            <span className="text-xs text-muted-foreground">{friends.length} ami{friends.length > 1 ? 's' : ''}</span>
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
              filteredFriends.map((friend) => (
                <div
                  key={friend.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-secondary/60 transition-all duration-200 group cursor-pointer"
                  onClick={() => handleMessage(friend.profile.user_id)}
                >
                  <div className="relative flex-shrink-0">
                    <UserAvatar src={friend.profile.avatar_url} alt={friend.profile.name} size="sm" />
                  </div>
                  <span className="text-sm font-medium truncate flex-1">{friend.profile.name}</span>
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
              ))
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}