import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, Send, X, Radio, StopCircle } from 'lucide-react';
import { LiveStreamPlayer, LiveStreamPlayerRef } from './LiveStreamPlayer';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLiveChat, useSendLiveChatMessage, useEndLive } from '@/hooks/useLiveStreams';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { LiveStream } from '@/hooks/useLiveStreams';

interface HostLiveViewProps {
  live: LiveStream;
}

export function HostLiveView({ live }: HostLiveViewProps) {
  const navigate = useNavigate();
  const playerRef = useRef<LiveStreamPlayerRef>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState('');
  const [showChat, setShowChat] = useState(true);
  const [isEnding, setIsEnding] = useState(false);
  
  const { data: chatMessages } = useLiveChat(live.id);
  const sendMessage = useSendLiveChatMessage();
  const endLive = useEndLive();

  // Auto-scroll chat
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;

    sendMessage.mutate({ liveId: live.id, message: message.trim() });
    setMessage('');
  };

  const handleEndLive = async () => {
    if (!confirm('Terminer le live ?')) return;
    
    setIsEnding(true);
    try {
      playerRef.current?.stopStream();
      await endLive.mutateAsync(live.id);
      toast({ title: 'Live terminé !' });
      navigate('/lives');
    } catch (error) {
      toast({ title: 'Erreur', variant: 'destructive' });
      setIsEnding(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black flex flex-col md:flex-row">
      {/* Video area */}
      <div className="flex-1 relative">
        <LiveStreamPlayer 
          ref={playerRef}
          isHost={true}
          className="w-full h-full"
        />

        {/* Top overlay */}
        <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/60 to-transparent pointer-events-none">
          <div className="flex items-center justify-between pointer-events-auto">
            <button 
              onClick={handleEndLive}
              disabled={isEnding}
              className="flex items-center gap-2 px-4 py-2 rounded-full bg-red-500 text-white font-medium"
            >
              <StopCircle className="w-4 h-4" />
              {isEnding ? 'Fin...' : 'Terminer'}
            </button>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-500 text-white text-sm font-bold">
                <Radio className="w-3.5 h-3.5 animate-pulse" />
                <span>EN DIRECT</span>
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

        {/* Title at bottom */}
        <div className="absolute bottom-24 left-4 right-4 md:bottom-8 pointer-events-none">
          <p className="text-white text-lg font-semibold drop-shadow-lg">{live.title}</p>
          {live.hashtags && live.hashtags.length > 0 && (
            <div className="flex gap-2 mt-1">
              {live.hashtags.map((tag, i) => (
                <span key={i} className="text-sm text-primary">#{tag}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Chat sidebar */}
      <div className={cn(
        "w-full md:w-80 bg-card/95 backdrop-blur-lg flex flex-col",
        "absolute md:relative inset-0 md:inset-auto",
        !showChat && "hidden md:flex"
      )}>
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="font-semibold">Chat en direct</h3>
          <button 
            onClick={() => setShowChat(false)}
            className="md:hidden w-8 h-8 rounded-full bg-secondary flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div ref={chatRef} className="flex-1 overflow-y-auto p-4 space-y-3">
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
              Aucun message pour l'instant
            </p>
          )}
        </div>

        <form onSubmit={handleSendMessage} className="p-4 border-t border-border">
          <div className="flex gap-2">
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Message..."
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
