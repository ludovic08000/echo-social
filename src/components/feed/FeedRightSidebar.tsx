import { Link } from 'react-router-dom';
import { MessageCircle, Search, Users, UserPlus, Check, X, Sparkles, Zap, Radio, Eye, Play } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useFriendships, useRespondToFriendRequest } from '@/hooks/useFriendships';
import { useConversations } from '@/hooks/useMessages';
import { useLiveStreams } from '@/hooks/useLiveStreams';
import { UserAvatar } from '@/components/UserAvatar';
import { useAuth } from '@/lib/auth';
import { useState, useMemo, useEffect } from 'react';
import { useScreenSize } from '@/hooks/useScreenSize';
import { useChatWidget } from '@/components/ChatWidgetContext';
import { useOnlinePresence } from '@/hooks/useOnlinePresence';
import { useZeusSettings } from '@/hooks/useZeusCompanion';
import { ZeusCompanion } from '@/components/ZeusCompanion';
import { cn } from '@/lib/utils';

export function FeedRightSidebar() {
  const { user } = useAuth();
  const { data: friendships } = useFriendships();
  const { data: conversations } = useConversations();
  const { data: liveStreams } = useLiveStreams();
  const [search, setSearch] = useState('');
  const { isDesktop } = useScreenSize();
  const { openConversation } = useChatWidget();
  const { isOnline } = useOnlinePresence();
  const respondToRequest = useRespondToFriendRequest();
  const { zeusName } = useZeusSettings();
  const friends = friendships?.friends || [];
  const requests = friendships?.requests || [];
  const [zeusOpen, setZeusOpen] = useState(false);

  useEffect(() => {
    const handler = () => setZeusOpen(true);
    window.addEventListener('open-zeus', handler);
    return () => window.removeEventListener('open-zeus', handler);
  }, []);

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

        {/* ── Lives en direct TikTok-style ── */}
        {liveStreams && liveStreams.length > 0 && (
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="relative rounded-2xl border border-border/40 bg-card overflow-hidden"
            style={{ boxShadow: 'var(--shadow-md)' }}
          >
            <div className="h-1 w-full bg-gradient-to-r from-destructive via-destructive/70 to-primary" />
            <div className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-destructive/10 flex items-center justify-center relative">
                    <Radio className="w-4 h-4 text-destructive animate-pulse" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-foreground leading-tight">En direct</h3>
                    <span className="text-[10px] text-destructive font-semibold">{liveStreams.length} live{liveStreams.length > 1 ? 's' : ''}</span>
                  </div>
                </div>
                <Link to="/lives" className="text-[11px] text-primary/80 font-medium hover:text-primary transition-colors">
                  Voir tout →
                </Link>
              </div>

              {/* TikTok-style vertical cards */}
              <div className="space-y-2.5">
                {liveStreams.slice(0, 3).map((live, i) => (
                  <motion.div
                    key={live.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.1 }}
                  >
                    <Link
                      to={`/live/${live.id}`}
                      className="block rounded-2xl overflow-hidden bg-black group relative aspect-[9/14]"
                    >
                      {/* Background */}
                      {live.thumbnail_url ? (
                        <img
                          src={live.thumbnail_url}
                          alt={live.title}
                          className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        />
                      ) : (
                        <div className="absolute inset-0 bg-gradient-to-br from-destructive/30 via-black to-primary/20 flex items-center justify-center">
                          <div className="w-14 h-14 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center group-hover:scale-110 transition-transform">
                            <Play className="w-6 h-6 text-white ml-0.5" />
                          </div>
                        </div>
                      )}

                      {/* Top badges */}
                      <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between z-10">
                        <span className="px-2 py-0.5 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center gap-1 shadow-lg">
                          <Radio className="w-2.5 h-2.5 animate-pulse" />
                          LIVE
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-sm text-white text-[10px] flex items-center gap-1">
                          <Eye className="w-2.5 h-2.5" />
                          {live.viewer_count}
                        </span>
                      </div>

                      {/* Bottom info */}
                      <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/90 via-black/50 to-transparent z-10">
                        <div className="flex items-center gap-2 mb-1.5">
                          <div className="relative flex-shrink-0">
                            <UserAvatar src={live.host?.avatar_url} alt={live.host?.name} size="xs" />
                            <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-destructive border border-black" />
                          </div>
                          <p className="text-white text-[11px] font-semibold truncate">{live.host?.name}</p>
                        </div>
                        <p className="text-white/80 text-[10px] whitespace-normal line-clamp-2 leading-snug">{live.title}</p>
                        {live.category && (
                          <span className="inline-block mt-1.5 px-2 py-0.5 rounded-full bg-white/10 backdrop-blur-sm text-white/70 text-[9px] font-medium">
                            {live.category}
                          </span>
                        )}
                      </div>

                      {/* Hover overlay */}
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-300" />
                    </Link>
                  </motion.div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
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

        {/* ── Zeus AI Companion Card (Sci-fi) ── */}
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, delay: 0.25, ease: [0.25, 0.46, 0.45, 0.94] }}
        >
          {!zeusOpen ? (
            <button
              onClick={() => setZeusOpen(true)}
              className="w-full rounded-2xl overflow-hidden transition-all duration-300 group cursor-pointer relative text-left"
              style={{
                background: 'linear-gradient(135deg, rgba(0,20,40,0.95) 0%, rgba(0,30,60,0.9) 50%, rgba(0,20,40,0.95) 100%)',
                border: '1px solid rgba(0,255,255,0.15)',
                boxShadow: '0 0 20px rgba(0,255,255,0.06)',
              }}
            >
              {/* Scan line */}
              <motion.div
                animate={{ y: ['-100%', '300%'] }}
                transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
                className="absolute left-0 right-0 h-6 opacity-[0.06] pointer-events-none"
                style={{ background: 'linear-gradient(180deg, transparent, rgba(0,255,255,0.4), transparent)' }}
              />
              {/* Top glow line */}
              <motion.div
                animate={{ opacity: [0.4, 0.8, 0.4] }}
                transition={{ duration: 2, repeat: Infinity }}
                className="h-[1px] w-full"
                style={{ background: 'linear-gradient(90deg, transparent, rgba(0,255,255,0.5), transparent)' }}
              />
              <div className="p-4 relative z-10">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center text-cyan-300 relative flex-shrink-0"
                    style={{
                      background: 'linear-gradient(135deg, rgba(0,255,255,0.12), rgba(0,100,200,0.12))',
                      border: '1px solid rgba(0,255,255,0.2)',
                      boxShadow: '0 0 15px rgba(0,255,255,0.12)',
                    }}>
                    <Zap className="w-5 h-5" />
                    <motion.div
                      animate={{ opacity: [0.2, 0.6, 0.2] }}
                      transition={{ duration: 2, repeat: Infinity }}
                      className="absolute inset-0 rounded-xl"
                      style={{ boxShadow: '0 0 12px rgba(0,255,255,0.25)' }}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-bold text-cyan-300" style={{ fontFamily: 'monospace' }}>{zeusName}</span>
                      <motion.span
                        animate={{ opacity: [0.3, 1, 0.3] }}
                        transition={{ duration: 1.5, repeat: Infinity }}
                        className="w-1.5 h-1.5 rounded-full bg-cyan-400"
                        style={{ boxShadow: '0 0 6px rgba(0,255,255,0.6)' }}
                      />
                    </div>
                    <p className="text-[10px] text-cyan-400/40 mt-0.5" style={{ fontFamily: 'monospace' }}>
                      Assistant IA • En ligne
                    </p>
                  </div>
                  <MessageCircle className="w-4 h-4 text-cyan-500/30 group-hover:text-cyan-400 transition-colors flex-shrink-0" />
                </div>
              </div>
            </button>
          ) : (
            <ZeusCompanion inline />
          )}
        </motion.div>
      </div>
    </aside>
  );
}
