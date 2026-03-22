import { useRef, useEffect, useState, useCallback } from 'react';
import { LiveViewerPlayer } from '@/components/live/LiveViewerPlayer';
import { HostLiveView } from '@/components/live/HostLiveView';
import { LiveRightActions } from '@/components/live/LiveRightActions';
import { LiveInfoOverlay } from '@/components/live/LiveInfoOverlay';
import { LiveMessageBar } from '@/components/live/LiveMessageBar';
import { UserAvatar } from '@/components/UserAvatar';
import { useLiveChat, useSendLiveChatMessage, useJoinLive, useLeaveLive, LiveStream } from '@/hooks/useLiveStreams';
import { useAuth } from '@/lib/auth';
import { generateLiveUrl } from '@/lib/urlUtils';

interface LivePlayerCardProps {
  item: {
    id: string;
    title: string;
    description?: string | null;
    thumbnail_url: string | null;
    is_active: boolean;
    viewer_count: number;
    total_views: number;
    category: string | null;
    hashtags?: string[];
    user_id: string;
    recording_url: string | null;
    started_at?: string | null;
    host?: { name: string; avatar_url: string | null };
  };
  isVisible: boolean;
  zeusReason?: string;
}

export function LivePlayerCard({ item, isVisible, zeusReason }: LivePlayerCardProps) {
  const { user } = useAuth();
  const replayVideoRef = useRef<HTMLVideoElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const { data: chatMessages } = useLiveChat(isVisible && item.is_active ? item.id : undefined);
  const sendMessage = useSendLiveChatMessage();
  const joinLive = useJoinLive();
  const leaveLive = useLeaveLive();
  const joinTimeRef = useRef<number>(0);
  const [showChat, setShowChat] = useState(true);

  const isHost = user?.id === item.user_id;

  // Join/leave for active lives (viewers only)
  useEffect(() => {
    if (!isVisible || !item.is_active || isHost) return;
    joinLive.mutate(item.id);
    joinTimeRef.current = Date.now();
    return () => {
      const watchTime = Math.floor((Date.now() - joinTimeRef.current) / 1000);
      leaveLive.mutate({ liveId: item.id, watchTimeSeconds: watchTime });
    };
  }, [isVisible, item.id, item.is_active, isHost]);

  // Autoplay/pause replay
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

  // Auto-scroll chat
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [chatMessages]);

  const handleSendMessage = useCallback((msg: string) => {
    sendMessage.mutate({ liveId: item.id, message: msg });
  }, [item.id, sendMessage]);

  // Host gets the full HostLiveView with camera controls
  if (isHost && item.is_active) {
    return <HostLiveView live={item as unknown as LiveStream} />;
  }

  return (
    <div className="relative w-full h-full bg-black overflow-hidden">
      {/* Video layer — LiveKit for active, recording for replays */}
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
            <img
              src={item.thumbnail_url}
              alt={item.title}
              className="absolute inset-0 w-full h-full object-cover"
            />
          ) : (
            <div className="absolute inset-0" style={{
              background: 'linear-gradient(160deg, hsl(260 40% 20%) 0%, hsl(220 30% 10%) 50%, hsl(190 30% 8%) 100%)',
            }} />
          )}
        </div>
      )}

      {/* Top gradient */}
      <div className="absolute top-0 left-0 right-0 h-32 bg-gradient-to-b from-black/60 to-transparent pointer-events-none z-10" />

      {/* Bottom gradient */}
      <div className="absolute bottom-0 left-0 right-0 h-64 bg-gradient-to-t from-black/80 via-black/40 to-transparent pointer-events-none z-10" />

      {/* Right actions */}
      <div className="absolute right-3 bottom-44 z-20">
        <LiveRightActions
          hostAvatar={item.host?.avatar_url}
          hostName={item.host?.name}
          viewerCount={item.is_active ? item.viewer_count : item.total_views}
          onCommentClick={() => setShowChat(!showChat)}
          shareUrl={generateLiveUrl(item.id)}
          shareTitle={item.title}
        />
      </div>

      {/* Bottom left info + chat */}
      <div className="absolute bottom-0 left-0 right-16 z-20">
        {/* Chat messages (realtime via Supabase) */}
        {item.is_active && showChat && chatMessages && chatMessages.length > 0 && (
          <div className="px-4 mb-2">
            <div ref={chatRef} className="max-h-32 overflow-y-auto space-y-1.5 scrollbar-none">
              {chatMessages.slice(-20).map((msg) => (
                <div key={msg.id} className="flex items-start gap-1.5">
                  <UserAvatar src={msg.sender?.avatar_url} alt={msg.sender?.name} size="xs" />
                  <p className="text-[12px] text-white/90 drop-shadow-lg">
                    <span className="font-semibold mr-1" style={{ color: 'hsl(190 80% 60%)' }}>
                      {msg.sender?.name}
                    </span>
                    {msg.message}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Host info overlay */}
        <div className="px-4 pb-2">
          <LiveInfoOverlay
            hostName={item.host?.name}
            hostAvatar={item.host?.avatar_url}
            title={item.title}
            category={item.category}
            viewerCount={item.is_active ? item.viewer_count : item.total_views}
            isActive={item.is_active}
            hashtags={item.hashtags}
            zeusReason={zeusReason}
          />
        </div>

        {/* Message bar with emoji picker */}
        {item.is_active && !isHost && (
          <div className="px-4 pb-[calc(env(safe-area-inset-bottom,0px)+16px)]">
            <LiveMessageBar onSend={handleSendMessage} />
          </div>
        )}

        {/* Replay padding */}
        {!item.is_active && <div className="h-[calc(env(safe-area-inset-bottom,0px)+16px)]" />}
      </div>
    </div>
  );
}
