import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Heart, Gift, Users, Send, Radio, X, ChevronUp, Eye, Clock } from 'lucide-react';
import { LiveEmojiPicker } from '@/components/live/LiveEmojiPicker';
import { useLiveStream, useLiveChat, useSendLiveChatMessage, useJoinLive, useLeaveLive, useLiveStreams } from '@/hooks/useLiveStreams';
import { LiveViewerPlayer } from '@/components/live/LiveViewerPlayer';
import { HostLiveView } from '@/components/live/HostLiveView';
import { UserAvatar } from '@/components/UserAvatar';
import { ShareButton } from '@/components/ShareButton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { generateLiveUrl } from '@/lib/urlUtils';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { motion } from 'framer-motion';
import { useQualityTracker } from '@/hooks/useQualityTracker';

interface AllLiveItem {
  id: string;
  title: string;
  thumbnail_url: string | null;
  is_active: boolean;
  viewer_count: number;
  total_views: number;
  category: string | null;
  user_id: string;
  recording_url: string | null;
  ended_at: string | null;
  started_at: string | null;
  host?: { name: string; avatar_url: string | null };
}

function useAllLives(targetId?: string) {
  return useQuery({
    queryKey: ['all-lives-feed', targetId],
    queryFn: async () => {
      // Single batched RPC (actives + replays + profiles)
      const { data: bundle } = await supabase.rpc('live_feed_bundle' as any, {
        p_user_id: null,
        p_active_limit: 80,
        p_replay_limit: 20,
      });

      const b = (bundle as {
        active: any[];
        replays: any[];
        profiles: Array<{ user_id: string; name: string; avatar_url: string | null }>;
      } | null) || { active: [], replays: [], profiles: [] };

      const profileMap = new Map(b.profiles.map(p => [p.user_id, { name: p.name, avatar_url: p.avatar_url }]));

      const all: AllLiveItem[] = [
        ...(b.active || []).map((l: any) => ({ ...l, ended_at: null as string | null, host: profileMap.get(l.user_id) })),
        ...(b.replays || []).map((r: any) => ({ ...r, viewer_count: r.viewer_count || 0, host: profileMap.get(r.user_id) })),
      ];

      // Targeted live not in bundle? Fetch on the side, prepend.
      if (targetId && !all.some(l => l.id === targetId)) {
        const { data: target } = await supabase
          .from('live_streams')
          .select('id, title, thumbnail_url, is_active, viewer_count, total_views, category, user_id, recording_url, ended_at, started_at')
          .eq('id', targetId)
          .single();
        if (target) {
          const { data: hostProfile } = await supabase
            .from('profiles').select('name, avatar_url').eq('user_id', target.user_id).maybeSingle();
          all.unshift({
            ...target,
            ended_at: target.ended_at || null,
            host: hostProfile ? { name: hostProfile.name, avatar_url: hostProfile.avatar_url } : undefined,
          } as AllLiveItem);
        }
      }

      // Prefetch next 3 thumbnails (CDN warm-up for swipe-up perf)
      try {
        all.slice(0, 4).forEach(l => {
          if (l.thumbnail_url) {
            const img = new Image();
            img.decoding = 'async';
            img.src = l.thumbnail_url;
          }
        });
      } catch {}

      return all;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });
}

// ─── Single Live Slide — Premium ───────────────────────────
function LiveSlide({ item, isVisible, backTo }: { item: AllLiveItem; isVisible: boolean; backTo: string }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const replayVideoRef = useRef<HTMLVideoElement>(null);
  const { data: chatMessages } = useLiveChat(isVisible && item.is_active ? item.id : undefined);
  const sendMessage = useSendLiveChatMessage();
  const joinLive = useJoinLive();
  const leaveLive = useLeaveLive();

  const [message, setMessage] = useState('');
  const [showChat, setShowChat] = useState(true);
  const chatRef = useRef<HTMLDivElement>(null);
  const joinTimeRef = useRef<number>(0);

  const isHost = user?.id === item.user_id;

  const quality = useQualityTracker({
    surface: 'live',
    contentId: item.id,
    authorId: item.user_id,
  });

  useEffect(() => {
    if (!isVisible || !item.is_active || isHost) return;
    joinLive.mutate(item.id);
    joinTimeRef.current = Date.now();
    quality.onEnter();
    return () => {
      const watchTime = Math.floor((Date.now() - joinTimeRef.current) / 1000);
      leaveLive.mutate({ liveId: item.id, watchTimeSeconds: watchTime });
      quality.onLeave();
    };
  }, [isVisible, item.id, item.is_active, isHost]);

  useEffect(() => {
    const video = replayVideoRef.current;
    if (!video) return;
    if (isVisible) {
      video.currentTime = 0;
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [isVisible]);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [chatMessages]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    sendMessage.mutate({ liveId: item.id, message: message.trim() });
    setMessage('');
  };

  if (isHost && item.is_active) {
    return <HostLiveView live={item as any} />;
  }

  return (
    <div className="relative w-full h-full bg-black">
      {/* Background */}
      {item.is_active ? (
        <LiveViewerPlayer
          roomName={`live-${item.id}`}
          thumbnailUrl={item.thumbnail_url || undefined}
          isLive
          className="w-full h-full"
        />
      ) : (
        <div className="absolute inset-0">
          {item.recording_url ? (
            <video
              ref={replayVideoRef}
              src={item.recording_url}
              className="absolute inset-0 w-full h-full object-cover"
              loop muted playsInline autoPlay={isVisible}
              poster={item.thumbnail_url || undefined}
            />
          ) : item.thumbnail_url ? (
            <>
              <img src={item.thumbnail_url} alt={item.title} className="absolute inset-0 w-full h-full object-cover" />
              <div className="absolute inset-0 bg-black/30" />
            </>
          ) : (
            <div className="absolute inset-0 bg-gradient-to-b from-primary/10 via-black to-black" />
          )}
        </div>
      )}

      {/* Top bar — refined */}
      <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/60 via-black/20 to-transparent z-20 pointer-events-none">
        <div className="flex items-center justify-between pointer-events-auto">
          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={() => navigate(backTo)}
            className="w-10 h-10 rounded-xl bg-white/[0.06] backdrop-blur-xl flex items-center justify-center text-white/70 border border-white/[0.06] hover:bg-white/[0.1] transition-all duration-300"
          >
            <ArrowLeft className="w-5 h-5" />
          </motion.button>

          <div className="flex items-center gap-2">
            {item.is_active ? (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-destructive/90 backdrop-blur-sm text-white text-[10px] font-bold tracking-wider uppercase">
                <Radio className="w-3 h-3 animate-pulse" />
                LIVE
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] backdrop-blur-xl text-white/60 text-[10px] font-semibold tracking-wider uppercase border border-white/[0.06]">
                <Clock className="w-3 h-3" />
                Replay
              </div>
            )}
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] backdrop-blur-xl text-white/60 text-[10px] font-semibold border border-white/[0.06]">
              <Eye className="w-3 h-3" />
              {item.is_active ? item.viewer_count : item.total_views}
            </div>
          </div>

          {item.is_active ? (
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => setShowChat(!showChat)}
              className="w-10 h-10 rounded-xl bg-white/[0.06] backdrop-blur-xl flex items-center justify-center text-white/70 border border-white/[0.06] hover:bg-white/[0.1] transition-all duration-300"
            >
              {showChat ? <X className="w-5 h-5" /> : <span className="text-base">💬</span>}
            </motion.button>
          ) : <div className="w-10" />}
        </div>
      </div>

      {/* Right side actions — premium glass */}
      <div className="absolute right-3 bottom-48 z-20 flex flex-col items-center gap-4">
        {[
          { icon: Heart, label: "J'aime" },
          { icon: Gift, label: 'Cadeau' },
        ].map(({ icon: Icon, label }) => (
          <div key={label} className="flex flex-col items-center gap-1">
            <motion.button
              whileTap={{ scale: 0.85 }}
              className="w-12 h-12 rounded-xl bg-white/[0.06] backdrop-blur-xl flex items-center justify-center text-white/80 border border-white/[0.06] hover:bg-white/[0.1] transition-all duration-300"
            >
              <Icon className="w-5 h-5" />
            </motion.button>
            <span className="text-white/35 text-[9px] font-semibold">{label}</span>
          </div>
        ))}
        <div className="flex flex-col items-center gap-1">
          <ShareButton
            url={generateLiveUrl(item.id)}
            title={item.title}
            variant="ghost"
            size="icon"
            className="w-12 h-12 rounded-xl bg-white/[0.06] backdrop-blur-xl text-white/80 hover:bg-white/[0.1] border border-white/[0.06]"
          />
          <span className="text-white/35 text-[9px] font-semibold">Partager</span>
        </div>
      </div>

      {/* Bottom: host info + chat */}
      <div className="absolute bottom-0 left-0 right-14 z-20 pointer-events-none">
        {/* Chat messages */}
        {item.is_active && showChat && chatMessages && chatMessages.length > 0 && (
          <div className="pointer-events-auto px-4">
            <div ref={chatRef} className="max-h-36 overflow-y-auto space-y-1.5 mb-2 scrollbar-none">
              {chatMessages.map(msg => (
                <div key={msg.id} className="flex gap-2 items-start">
                  <UserAvatar src={msg.sender?.avatar_url} alt={msg.sender?.name} size="xs" />
                  <p className="text-[13px] text-white/90 drop-shadow-lg">
                    <span className="font-semibold text-primary/80 mr-1.5">{msg.sender?.name}</span>
                    {msg.message}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Host info — refined */}
        <div className="px-4 pb-2 pointer-events-auto">
          <div className="flex items-center gap-3 mb-2">
            <div className="relative">
              <UserAvatar src={item.host?.avatar_url} alt={item.host?.name} size="md" />
              {item.is_active && (
                <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-destructive border-2 border-black" />
              )}
            </div>
            <div>
              <p className="text-white font-semibold text-sm drop-shadow-lg tracking-tight">{item.host?.name || 'Utilisateur'}</p>
              {item.category && (
                <span className="text-white/30 text-[10px] font-medium uppercase tracking-wider">{item.category}</span>
              )}
            </div>
          </div>
          <p className="text-white/70 text-[13px] leading-snug drop-shadow-lg mb-1 font-medium">{item.title}</p>
          {!item.is_active && item.ended_at && (
            <p className="text-white/25 text-[11px] font-medium">
              {formatDistanceToNow(new Date(item.ended_at), { addSuffix: true, locale: fr })}
            </p>
          )}
        </div>

        {/* Chat input — premium */}
        {item.is_active && (
          <form
            onSubmit={handleSendMessage}
            className="px-4 pt-2 pb-[calc(env(safe-area-inset-bottom,0px)+16px)] bg-gradient-to-t from-black/80 to-transparent pointer-events-auto"
          >
            <div className="flex gap-2">
              <Input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Envoyer un message..."
                className="flex-1 h-10 bg-white/[0.06] border-white/[0.08] text-white text-sm placeholder:text-white/25 rounded-xl px-4 backdrop-blur-xl"
              />
              <LiveEmojiPicker onSelect={(emoji) => setMessage(prev => prev + emoji)} />
              <Button type="submit" size="icon" disabled={!message.trim()} className="h-10 w-10 rounded-xl bg-primary/90 text-primary-foreground hover:bg-primary">
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* Scroll hint */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
        <ChevronUp className="w-5 h-5 text-white/15 animate-bounce" />
      </div>
    </div>
  );
}

// ─── Main: TikTok-style vertical scroll ─────────────────────────
export default function LiveWatch() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const fromFeed = searchParams.get('from') === 'feed';
  const navigate = useNavigate();
  const { data: allLives, isLoading } = useAllLives(id);

  const containerRef = useRef<HTMLDivElement>(null);
  const [currentIndex, setCurrentIndex] = useState(0);

  const orderedItems = (() => {
    if (!allLives?.length) return [];
    if (!id) return allLives;
    const clickedIndex = allLives.findIndex(l => l.id === id);
    if (clickedIndex <= 0) return allLives;
    const clicked = allLives[clickedIndex];
    return [clicked, ...allLives.filter(l => l.id !== id)];
  })();

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollTop = container.scrollTop;
    const height = container.clientHeight;
    const newIndex = Math.round(scrollTop / height);
    if (newIndex !== currentIndex && newIndex >= 0 && newIndex < orderedItems.length) {
      setCurrentIndex(newIndex);
      const newItem = orderedItems[newIndex];
      if (newItem) {
        window.history.replaceState(null, '', `/live/${newItem.id}`);
      }
      // Prefetch next 2 LiveKit tokens for instant swipe-up
      for (let i = 1; i <= 2; i++) {
        const next = orderedItems[newIndex + i];
        if (next?.is_active) {
          import('@/lib/livekit').then(m => m.prefetchLiveKitToken(`live-${next.id}`)).catch(() => {});
        }
      }
    }
  }, [currentIndex, orderedItems]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center">
            <Radio className="w-6 h-6 text-white/30 animate-pulse" />
          </div>
          <span className="text-white/25 text-xs font-medium tracking-wide">Chargement</span>
        </div>
      </div>
    );
  }

  if (!orderedItems.length) {
    return (
      <div className="fixed inset-0 bg-black flex flex-col items-center justify-center text-white gap-5">
        <div className="w-20 h-20 rounded-3xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center">
          <Radio className="w-9 h-9 text-white/15" />
        </div>
        <div className="text-center space-y-2">
          <h2 className="text-white/80 font-semibold text-base">Aucun live disponible</h2>
          <p className="text-white/25 text-sm font-medium">Revenez plus tard</p>
        </div>
        <Button onClick={() => navigate('/lives')} variant="outline" className="border-white/[0.1] text-white/60 hover:bg-white/[0.06] rounded-xl">
          Retour
        </Button>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 bg-black overflow-y-auto snap-y snap-mandatory scrollbar-none"
      style={{ WebkitOverflowScrolling: 'touch' }}
    >
      {orderedItems.map((item, index) => (
        <div key={item.id} className="w-full h-screen snap-start snap-always">
          <LiveSlide item={item} isVisible={index === currentIndex} backTo="/live" />
        </div>
      ))}
    </div>
  );
}
