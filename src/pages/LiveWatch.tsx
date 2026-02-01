import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Heart, Gift, Share2, Users, Send, Radio, X } from 'lucide-react';
import { useLiveStream, useLiveChat, useSendLiveChatMessage, useJoinLive, useLeaveLive } from '@/hooks/useLiveStreams';
import { LiveViewerPlayer } from '@/components/live/LiveViewerPlayer';
import { HostLiveView } from '@/components/live/HostLiveView';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';

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

  const handleShare = async () => {
    try {
      if (navigator.share) {
        await navigator.share({
          title: live?.title || 'Live',
          url: window.location.href,
        });
      } else {
        await navigator.clipboard.writeText(window.location.href);
        toast({ title: 'Lien copié !' });
      }
    } catch {
      // User cancelled share or error
    }
  };

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

  // Viewer view
  return (
    <div className="fixed inset-0 bg-black flex flex-col md:flex-row">
      {/* Video area */}
      <div className="flex-1 relative">
        <LiveViewerPlayer 
          thumbnailUrl={live.thumbnail_url || undefined}
          isLive={live.is_active}
          className="w-full h-full"
        />

        {/* Top overlay */}
        <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/60 to-transparent pointer-events-none">
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
              className="md:hidden w-10 h-10 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center text-white"
            >
              {showChat ? <X className="w-5 h-5" /> : <span>💬</span>}
            </button>
          </div>
        </div>

        {/* Host info */}
        <div className="absolute bottom-4 left-4 right-4 md:bottom-8 md:left-8 pointer-events-none">
          <div className="flex items-center gap-3 mb-2">
            <UserAvatar src={live.host?.avatar_url} alt={live.host?.name} size="md" />
            <div>
              <p className="text-white font-semibold">{live.host?.name}</p>
              <p className="text-white/70 text-sm">{live.title}</p>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2 mt-3 pointer-events-auto">
            <Button size="sm" variant="secondary" className="bg-white/10 hover:bg-white/20 text-white">
              <Heart className="w-4 h-4 mr-1" />
              J'aime
            </Button>
            <Button size="sm" variant="secondary" className="bg-white/10 hover:bg-white/20 text-white">
              <Gift className="w-4 h-4 mr-1" />
              Cadeau
            </Button>
            <Button size="sm" variant="secondary" className="bg-white/10 hover:bg-white/20 text-white" onClick={handleShare}>
              <Share2 className="w-4 h-4 mr-1" />
              Partager
            </Button>
          </div>
        </div>
      </div>

      {/* Chat sidebar */}
      <div className={cn(
        "w-full md:w-80 bg-card/95 backdrop-blur-lg flex flex-col",
        "absolute md:relative inset-0 md:inset-auto",
        !showChat && "hidden md:flex"
      )}>
        {/* Chat header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="font-semibold">Chat en direct</h3>
          <button 
            onClick={() => setShowChat(false)}
            className="md:hidden w-8 h-8 rounded-full bg-secondary flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Messages */}
        <div 
          ref={chatRef}
          className="flex-1 overflow-y-auto p-4 space-y-3"
        >
          {chatMessages?.map(msg => (
            <div key={msg.id} className="flex gap-2">
              <UserAvatar src={msg.sender?.avatar_url} alt={msg.sender?.name} size="xs" />
              <div>
                <span className="text-sm font-medium text-primary">{msg.sender?.name}</span>
                <p className="text-sm text-foreground">{msg.message}</p>
              </div>
            </div>
          ))}

          {(!chatMessages || chatMessages.length === 0) && (
            <p className="text-center text-muted-foreground text-sm py-8">
              Sois le premier à envoyer un message !
            </p>
          )}
        </div>

        {/* Message input */}
        <form onSubmit={handleSendMessage} className="p-4 border-t border-border">
          <div className="flex gap-2">
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Envoie un message..."
              className="flex-1"
            />
            <Button type="submit" size="icon" disabled={!message.trim()}>
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
