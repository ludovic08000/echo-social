import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Heart, Gift, Users, Send, Radio, X } from 'lucide-react';
import { useLiveStream, useLiveChat, useSendLiveChatMessage, useJoinLive, useLeaveLive } from '@/hooks/useLiveStreams';
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

export default function LiveWatch() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: live, isLoading } = useLiveStream(id);
  const { data: chatMessages } = useLiveChat(id);
  const sendMessage = useSendLiveChatMessage();
  const joinLive = useJoinLive();
  const leaveLive = useLeaveLive();
  
  const [message, setMessage] = useState('');
  const [showChat, setShowChat] = useState(true);
  const chatRef = useRef<HTMLDivElement>(null);
  const joinTimeRef = useRef<number>(Date.now());

  const isHost = user?.id === live?.user_id;

  // Join live on mount (for viewers only)
  useEffect(() => {
    if (id && !isHost) {
      joinLive.mutate(id);
      joinTimeRef.current = Date.now();
    }

    return () => {
      if (id && !isHost) {
        const watchTime = Math.floor((Date.now() - joinTimeRef.current) / 1000);
        leaveLive.mutate({ liveId: id, watchTimeSeconds: watchTime });
      }
    };
  }, [id, isHost]);

  // Auto-scroll chat
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || !id) return;

    sendMessage.mutate({ liveId: id, message: message.trim() });
    setMessage('');
  };

  const liveUrl = id ? generateLiveUrl(id) : '';

  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-white">
          <Radio className="w-12 h-12 animate-pulse text-destructive" />
          <span>Connexion au live...</span>
        </div>
      </div>
    );
  }

  if (!live) {
    return (
      <div className="fixed inset-0 bg-black flex flex-col items-center justify-center text-white gap-4">
        <Radio className="w-16 h-16 text-muted-foreground" />
        <h2 className="text-xl font-semibold">Live introuvable</h2>
        <p className="text-muted-foreground">Ce live n'existe pas ou est terminé</p>
        <Button onClick={() => navigate('/lives')} variant="outline">
          Retour aux lives
        </Button>
      </div>
    );
  }

  if (!live.is_active) {
    return (
      <div className="fixed inset-0 bg-black flex flex-col items-center justify-center text-white gap-4">
        <Radio className="w-16 h-16 text-muted-foreground" />
        <h2 className="text-xl font-semibold">Live terminé</h2>
        <p className="text-muted-foreground">Ce live est maintenant terminé</p>
        <Button onClick={() => navigate('/lives')} variant="outline">
          Voir d'autres lives
        </Button>
      </div>
    );
  }

  // Host view with camera controls
  if (isHost) {
    return <HostLiveView live={live} />;
  }

  // Viewer view — chat overlay at bottom
  return (
    <div className="fixed inset-0 bg-black flex flex-col">
      {/* Video area — fills the entire screen */}
      <div className="flex-1 relative">
        <LiveViewerPlayer 
          roomName={`live-${live.id}`}
          thumbnailUrl={live.thumbnail_url || undefined}
          isLive={live.is_active}
          className="w-full h-full"
        />

        {/* Top overlay */}
        <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/60 to-transparent pointer-events-none z-10">
          <div className="flex items-center justify-between pointer-events-auto">
            <button 
              onClick={() => navigate('/lives')}
              className="w-10 h-10 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center text-white"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-destructive text-destructive-foreground text-sm font-bold">
                <Radio className="w-3.5 h-3.5 animate-pulse" />
                <span>LIVE</span>
              </div>
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/50 backdrop-blur-sm text-white text-sm">
                <Users className="w-4 h-4" />
                <span>{live.viewer_count}</span>
              </div>
            </div>

            <button 
              onClick={() => setShowChat(!showChat)}
              className="w-10 h-10 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center text-white"
            >
              {showChat ? <X className="w-5 h-5" /> : <span>💬</span>}
            </button>
          </div>
        </div>

        {/* Bottom overlay: host info + actions + chat */}
        <div className="absolute bottom-0 left-0 right-0 z-10 pointer-events-none">
          {/* Chat messages — scrollable, overlaid on video */}
          {showChat && (
            <div className="pointer-events-auto px-3">
              <div
                ref={chatRef}
                className="max-h-48 overflow-y-auto space-y-1.5 mb-2 scrollbar-none"
              >
                {chatMessages?.map(msg => (
                  <div key={msg.id} className="flex gap-2 items-start">
                    <UserAvatar src={msg.sender?.avatar_url} alt={msg.sender?.name} size="xs" />
                    <p className="text-sm text-white drop-shadow-lg">
                      <span className="font-semibold text-primary mr-1">{msg.sender?.name}</span>
                      {msg.message}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Host info + actions */}
          <div className="px-3 pb-2 pointer-events-auto">
            <div className="flex items-center gap-3 mb-2">
              <UserAvatar src={live.host?.avatar_url} alt={live.host?.name} size="md" />
              <div>
                <p className="text-white font-semibold drop-shadow-lg">{live.host?.name}</p>
                <p className="text-white/70 text-sm drop-shadow-lg">{live.title}</p>
              </div>
            </div>

            <div className="flex gap-2 mb-2">
              <Button size="sm" variant="secondary" className="bg-white/10 hover:bg-white/20 text-white border-0">
                <Heart className="w-4 h-4 mr-1" />
                J'aime
              </Button>
              <Button size="sm" variant="secondary" className="bg-white/10 hover:bg-white/20 text-white border-0">
                <Gift className="w-4 h-4 mr-1" />
                Cadeau
              </Button>
              <ShareButton
                url={liveUrl}
                title={live.title}
                variant="secondary"
                size="sm"
                showLabel
                className="bg-white/10 hover:bg-white/20 text-white border-0"
              />
            </div>
          </div>

          {/* Chat input — pinned at very bottom */}
          <form onSubmit={handleSendMessage} className="px-3 pb-4 pt-2 bg-gradient-to-t from-black/80 to-transparent pointer-events-auto">
            <div className="flex gap-2">
              <Input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Envoie un message..."
                className="flex-1 bg-white/10 border-white/20 text-white placeholder:text-white/50"
              />
              <Button type="submit" size="icon" disabled={!message.trim()} className="bg-primary text-primary-foreground">
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
