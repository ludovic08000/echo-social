import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Heart, Gift, Users, Send, Radio, X, Play, ChevronUp, ChevronDown, Eye, Clock } from 'lucide-react';
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
      // Fetch active lives
      const { data: activeLives } = await supabase
        .from('live_streams')
        .select('id, title, thumbnail_url, is_active, viewer_count, total_views, category, user_id, recording_url, started_at')
        .eq('is_active', true)
        .order('viewer_count', { ascending: false });

      // Fetch recent replays
      const { data: replays } = await supabase
        .from('live_streams')
        .select('id, title, thumbnail_url, is_active, viewer_count, total_views, category, user_id, recording_url, ended_at, started_at')
        .eq('is_active', false)
        .not('ended_at', 'is', null)
        .order('ended_at', { ascending: false })
        .limit(20);

      const all = [
        ...(activeLives || []).map(l => ({ ...l, ended_at: null as string | null })),
        ...(replays || []).map(r => ({ ...r, viewer_count: r.viewer_count || 0 })),
      ];

      // If the target replay isn't already in the list, fetch it separately
      if (targetId && !all.some(l => l.id === targetId)) {
        const { data: target } = await supabase
          .from('live_streams')
          .select('id, title, thumbnail_url, is_active, viewer_count, total_views, category, user_id, recording_url, ended_at, started_at')
          .eq('id', targetId)
          .single();
        if (target) {
          all.unshift({ ...target, ended_at: target.ended_at || null });
        }
      }

      if (!all.length) return [];

      const hostIds = [...new Set(all.map(l => l.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', hostIds);

      const profileMap = new Map(
        (profiles || []).map(p => [p.user_id, { name: p.name, avatar_url: p.avatar_url }])
      );

      return all.map(l => ({
        ...l,
        host: profileMap.get(l.user_id),
      })) as AllLiveItem[];
    },
    staleTime: 30_000,
  });
}

// ─── Single Live Slide ─────────────────────────────────────────
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

  // Join/leave for active lives
  useEffect(() => {
    if (!isVisible || !item.is_active || isHost) return;
    joinLive.mutate(item.id);
    joinTimeRef.current = Date.now();

    return () => {
      const watchTime = Math.floor((Date.now() - joinTimeRef.current) / 1000);
      leaveLive.mutate({ liveId: item.id, watchTimeSeconds: watchTime });
    };
  }, [isVisible, item.id, item.is_active, isHost]);

  // Autoplay/pause replay video based on visibility
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

  // Host gets their own view
  if (isHost && item.is_active) {
    return <HostLiveView live={item as any} />;
  }

  return (
    <div className="relative w-full h-full bg-black">
      {/* Background: LiveKit stream for active, thumbnail for replays */}
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
              loop
              muted
              playsInline
              autoPlay={isVisible}
              poster={item.thumbnail_url || undefined}
            />
          ) : item.thumbnail_url ? (
            <>
              <img
                src={item.thumbnail_url}
                alt={item.title}
                className="absolute inset-0 w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-black/30" />
            </>
          ) : (
            <div className="absolute inset-0 bg-gradient-to-b from-primary/20 via-black to-black" />
          )}
        </div>
      )}

      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/70 to-transparent z-20 pointer-events-none">
        <div className="flex items-center justify-between pointer-events-auto">
          <button
            onClick={() => navigate(backTo)}
            className="w-10 h-10 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center text-white"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-2">
            {item.is_active ? (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-destructive text-white text-xs font-bold">
                <Radio className="w-3 h-3 animate-pulse" />
                LIVE
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 backdrop-blur-sm text-white text-xs font-medium">
                <Clock className="w-3 h-3" />
                Replay
              </div>
            )}
            <div className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-black/40 backdrop-blur-sm text-white text-xs">
              <Eye className="w-3 h-3" />
              {item.is_active ? item.viewer_count : item.total_views}
            </div>
          </div>

          {item.is_active && (
            <button
              onClick={() => setShowChat(!showChat)}
              className="w-10 h-10 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center text-white"
            >
              {showChat ? <X className="w-5 h-5" /> : <span className="text-lg">💬</span>}
            </button>
          )}
          {!item.is_active && <div className="w-10" />}
        </div>
      </div>

      {/* Right side actions */}
      <div className="absolute right-3 bottom-48 z-20 flex flex-col items-center gap-5">
        <div className="flex flex-col items-center gap-1">
          <button className="w-11 h-11 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center text-white active:scale-90 transition-transform">
            <Heart className="w-5 h-5" />
          </button>
          <span className="text-white/70 text-[10px]">J'aime</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <button className="w-11 h-11 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center text-white active:scale-90 transition-transform">
            <Gift className="w-5 h-5" />
          </button>
          <span className="text-white/70 text-[10px]">Cadeau</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <ShareButton
            url={generateLiveUrl(item.id)}
            title={item.title}
            variant="ghost"
            size="icon"
            className="w-11 h-11 rounded-full bg-black/30 backdrop-blur-sm text-white hover:bg-black/50"
          />
          <span className="text-white/70 text-[10px]">Partager</span>
        </div>
      </div>

      {/* Bottom: host info + chat */}
      <div className="absolute bottom-0 left-0 right-14 z-20 pointer-events-none">
        {/* Chat messages for active lives */}
        {item.is_active && showChat && chatMessages && chatMessages.length > 0 && (
          <div className="pointer-events-auto px-4">
            <div ref={chatRef} className="max-h-36 overflow-y-auto space-y-1 mb-2 scrollbar-none">
              {chatMessages.map(msg => (
                <div key={msg.id} className="flex gap-1.5 items-start">
                  <UserAvatar src={msg.sender?.avatar_url} alt={msg.sender?.name} size="xs" />
                  <p className="text-[13px] text-white drop-shadow-lg">
                    <span className="font-semibold text-primary mr-1">{msg.sender?.name}</span>
                    {msg.message}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Host info */}
        <div className="px-4 pb-2 pointer-events-auto">
          <div className="flex items-center gap-2.5 mb-1.5">
            <div className="relative">
              <UserAvatar src={item.host?.avatar_url} alt={item.host?.name} size="md" />
              {item.is_active && (
                <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-destructive border-2 border-black" />
              )}
            </div>
            <div>
              <p className="text-white font-semibold text-sm drop-shadow-lg">{item.host?.name || 'Utilisateur'}</p>
              {item.category && (
                <span className="text-white/50 text-[11px]">{item.category}</span>
              )}
            </div>
          </div>
          <p className="text-white/80 text-[13px] leading-snug drop-shadow-lg mb-1">{item.title}</p>
          {!item.is_active && item.ended_at && (
            <p className="text-white/40 text-[11px]">
              {formatDistanceToNow(new Date(item.ended_at), { addSuffix: true, locale: fr })}
            </p>
          )}
        </div>

        {/* Chat input for active lives */}
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
                className="flex-1 h-9 bg-white/10 border-white/20 text-white text-sm placeholder:text-white/40 rounded-full px-4"
              />
              <LiveEmojiPicker onSelect={(emoji) => setMessage(prev => prev + emoji)} />
              <Button type="submit" size="icon" disabled={!message.trim()} className="h-9 w-9 rounded-full bg-primary text-primary-foreground">
                <Send className="w-3.5 h-3.5" />
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* Scroll hint */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
        <ChevronUp className="w-5 h-5 text-white/30 animate-bounce" />
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

  // Order: put the clicked item first, then the rest
  const orderedItems = (() => {
    if (!allLives?.length) return [];
    if (!id) return allLives;
    const clickedIndex = allLives.findIndex(l => l.id === id);
    if (clickedIndex <= 0) return allLives;
    const clicked = allLives[clickedIndex];
    return [clicked, ...allLives.filter(l => l.id !== id)];
  })();

  // Handle snap scroll
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollTop = container.scrollTop;
    const height = container.clientHeight;
    const newIndex = Math.round(scrollTop / height);
    if (newIndex !== currentIndex && newIndex >= 0 && newIndex < orderedItems.length) {
      setCurrentIndex(newIndex);
      // Update URL without navigation
      const newItem = orderedItems[newIndex];
      if (newItem) {
        window.history.replaceState(null, '', `/live/${newItem.id}`);
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
        <div className="flex flex-col items-center gap-4 text-white">
          <Radio className="w-12 h-12 animate-pulse text-destructive" />
          <span className="text-sm">Chargement...</span>
        </div>
      </div>
    );
  }

  if (!orderedItems.length) {
    return (
      <div className="fixed inset-0 bg-black flex flex-col items-center justify-center text-white gap-4">
        <Radio className="w-16 h-16 text-muted-foreground" />
        <h2 className="text-xl font-semibold">Aucun live disponible</h2>
        <p className="text-white/50 text-sm">Revenez plus tard</p>
        <Button onClick={() => navigate('/lives')} variant="outline" className="border-white/20 text-white hover:bg-white/10">
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
        <div
          key={item.id}
          className="w-full h-screen snap-start snap-always"
        >
          <LiveSlide item={item} isVisible={index === currentIndex} backTo={fromFeed ? '/live' : '/live'} />
        </div>
      ))}
    </div>
  );
}
