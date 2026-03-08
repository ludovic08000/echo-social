import { Link } from 'react-router-dom';
import { MessageCircle, Search, Users, UserPlus, Check, X, Sparkles, Zap, Radio, Eye, Play } from 'lucide-react';
import { useFriendships, useRespondToFriendRequest } from '@/hooks/useFriendships';
import { useConversations } from '@/hooks/useMessages';
import { useLiveStreams } from '@/hooks/useLiveStreams';
import { UserAvatar } from '@/components/UserAvatar';
import { useAuth } from '@/lib/auth';
import { useState, useMemo } from 'react';
import { useScreenSize } from '@/hooks/useScreenSize';
import { useChatWidget } from '@/components/ChatWidgetContext';
import { useOnlinePresence } from '@/hooks/useOnlinePresence';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';

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
    <aside className="hidden lg:block w-[300px] flex-shrink-0">
      <div className="sticky top-20 space-y-5 pl-4 max-h-[calc(100vh-100px)] overflow-y-auto scrollbar-thin pr-1">

        {/* ── Friend Requests Card ── */}
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="relative rounded-2xl border border-border/40 bg-card overflow-hidden"
          style={{ boxShadow: 'var(--shadow-md)' }}
        >
          {/* Gradient accent top bar */}
          <div className="h-1 w-full" style={{ background: 'var(--premium-gradient)' }} />
          
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
                  <UserPlus className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-foreground leading-tight">Demandes</h3>
                  {requests.length > 0 && (
                    <span className="text-[10px] text-primary font-semibold">{requests.length} nouvelle{requests.length > 1 ? 's' : ''}</span>
                  )}
                </div>
              </div>
              <Link to="/friends" className="text-[11px] text-primary/80 font-medium hover:text-primary transition-colors">
                Voir tout →
              </Link>
            </div>

            <AnimatePresence mode="wait">
              {requests.length === 0 ? (
                <motion.div
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex items-center gap-3 py-4 px-3 rounded-xl bg-secondary/20"
                >
                  <div className="w-10 h-10 rounded-full bg-secondary/60 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-muted-foreground/50" />
                  </div>
                  <p className="text-xs text-muted-foreground/70 leading-snug">
                    Pas de nouvelles demandes.<br/>
                    <Link to="/friends" className="text-primary font-medium hover:underline">Découvrir des profils</Link>
                  </p>
                </motion.div>
              ) : (
                <div className="space-y-2">
                  {requests.slice(0, 3).map((req, i) => (
                    <motion.div
                      key={req.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.08 }}
                      className="relative p-3 rounded-xl bg-secondary/20 hover:bg-secondary/40 transition-all duration-300 group"
                    >
                      <div className="flex items-center gap-3">
                        <div className="relative">
                          <UserAvatar src={req.profile.avatar_url} alt={req.profile.name} size="md" />
                          <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-primary flex items-center justify-center border-2 border-card">
                            <UserPlus className="w-2 h-2 text-primary-foreground" />
                          </div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold truncate text-foreground">{req.profile.name}</p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">Souhaite vous ajouter</p>
                        </div>
                      </div>
                      <div className="flex gap-2 mt-3">
                        <button
                          onClick={() => respondToRequest.mutate({ friendshipId: req.id, accept: true })}
                          disabled={respondToRequest.isPending}
                          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-bold transition-all duration-200 active:scale-95 bg-primary text-primary-foreground hover:shadow-lg hover:shadow-primary/25"
                          style={{ boxShadow: '0 2px 8px hsl(220 70% 50% / 0.2)' }}
                        >
                          <Check className="w-3.5 h-3.5" />
                          Confirmer
                        </button>
                        <button
                          onClick={() => respondToRequest.mutate({ friendshipId: req.id, accept: false })}
                          disabled={respondToRequest.isPending}
                          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-secondary/80 text-muted-foreground text-xs font-semibold hover:bg-destructive/10 hover:text-destructive transition-all duration-200 active:scale-95"
                        >
                          Supprimer
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>

        {/* ── Online Contacts Card ── */}
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, delay: 0.15, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="relative rounded-2xl border border-border/40 bg-card overflow-hidden"
          style={{ boxShadow: 'var(--shadow-md)' }}
        >
          <div className="p-4 pb-2">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center relative">
                  <Users className="w-4 h-4 text-primary" />
                  {onlineFriendsCount > 0 && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 text-white text-[8px] font-bold flex items-center justify-center border-2 border-card">
                      {onlineFriendsCount}
                    </span>
                  )}
                </div>
                <div>
                  <h3 className="text-sm font-bold text-foreground leading-tight">Contacts</h3>
                  <span className="text-[10px] text-muted-foreground">
                    {onlineFriendsCount > 0 ? (
                      <><span className="text-emerald-500 font-semibold">{onlineFriendsCount} en ligne</span> · {friends.length} total</>
                    ) : (
                      <>{friends.length} ami{friends.length > 1 ? 's' : ''}</>
                    )}
                  </span>
                </div>
              </div>
            </div>

            {/* Search */}
            {friends.length > 4 && (
              <div className="mb-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
                  <input
                    type="text"
                    placeholder="Rechercher..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 text-xs rounded-xl bg-secondary/40 border border-border/30 outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30 placeholder:text-muted-foreground/40 transition-all duration-200"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Friends list */}
          <div className="px-2 pb-3 space-y-0.5 max-h-[380px] overflow-y-auto scrollbar-thin">
            {filteredFriends.length === 0 ? (
              <div className="px-3 py-8 text-center">
                {friends.length === 0 ? (
                  <div className="space-y-3">
                    <div className="w-14 h-14 rounded-2xl bg-secondary/40 flex items-center justify-center mx-auto">
                      <Users className="w-6 h-6 text-muted-foreground/30" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">Pas encore d'amis</p>
                      <p className="text-[11px] text-muted-foreground/60 mt-1">Commencez à vous connecter</p>
                    </div>
                    <Link 
                      to="/friends" 
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:shadow-lg hover:shadow-primary/20 transition-all active:scale-95"
                    >
                      <Zap className="w-3 h-3" />
                      Trouver des amis
                    </Link>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground/60">Aucun résultat</p>
                )}
              </div>
            ) : (
              filteredFriends.map((friend, i) => {
                const online = isOnline(friend.profile.user_id);
                return (
                  <motion.div
                    key={friend.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: i * 0.03 }}
                    className="flex items-center gap-3 px-2.5 py-2 rounded-xl hover:bg-secondary/50 transition-all duration-200 group cursor-pointer"
                    onClick={() => handleMessage(friend.profile.user_id)}
                  >
                    <div className="relative flex-shrink-0">
                      <UserAvatar src={friend.profile.avatar_url} alt={friend.profile.name} size="sm" />
                      <div className={cn(
                        'absolute bottom-0 right-0 w-3 h-3 rounded-full border-[2.5px] border-card transition-all duration-300',
                        online 
                          ? 'bg-emerald-500 shadow-[0_0_6px_hsl(145,80%,42%,0.5)]' 
                          : 'bg-muted-foreground/20'
                      )} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className={cn(
                        "text-[13px] truncate block leading-tight",
                        online ? "font-semibold text-foreground" : "font-medium text-foreground/80"
                      )}>
                        {friend.profile.name}
                      </span>
                      <span className={cn(
                        "text-[10px] leading-none mt-0.5 block",
                        online ? "text-emerald-500 font-medium" : "text-muted-foreground/50"
                      )}>
                        {online ? 'Actif maintenant' : 'Hors ligne'}
                      </span>
                    </div>
                    <button
                      className="opacity-0 group-hover:opacity-100 w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary hover:bg-primary hover:text-primary-foreground transition-all duration-200 active:scale-90"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMessage(friend.profile.user_id);
                      }}
                      title="Envoyer un message"
                    >
                      <MessageCircle className="w-3.5 h-3.5" />
                    </button>
                  </motion.div>
                );
              })
            )}
          </div>
        </motion.div>
      </div>
    </aside>
  );
}
