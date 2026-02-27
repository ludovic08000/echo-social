import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, Send, Radio, StopCircle } from 'lucide-react';
import { LiveStreamPlayer, LiveStreamPlayerRef } from './LiveStreamPlayer';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLiveChat, useSendLiveChatMessage, useEndLive } from '@/hooks/useLiveStreams';
import { toast } from '@/hooks/use-toast';
import { LiveStream } from '@/hooks/useLiveStreams';

interface HostLiveViewProps {
  live: LiveStream;
}

export function HostLiveView({ live }: HostLiveViewProps) {
  const navigate = useNavigate();
  const playerRef = useRef<LiveStreamPlayerRef>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState('');
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
    <div className="fixed inset-0 bg-black flex flex-col">
      {/* Video — full screen */}
      <div className="flex-1 relative">
        <LiveStreamPlayer 
          ref={playerRef}
          isHost={true}
          roomName={`live-${live.id}`}
          className="w-full h-full"
        />

        {/* Top overlay */}
        <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/60 to-transparent pointer-events-none z-10">
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
          </div>
        </div>

        {/* Bottom overlay: title + chat + input */}
        <div className="absolute bottom-0 left-0 right-0 z-10 pointer-events-none">
          {/* Title */}
          <div className="px-3 mb-2 pointer-events-none">
            <p className="text-white text-lg font-semibold drop-shadow-lg">{live.title}</p>
            {live.hashtags && live.hashtags.length > 0 && (
              <div className="flex gap-2 mt-1">
                {live.hashtags.map((tag, i) => (
                  <span key={i} className="text-sm text-primary">#{tag}</span>
                ))}
              </div>
            )}
          </div>

          {/* Chat messages overlay */}
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

              {(!chatMessages || chatMessages.length === 0) && (
                <p className="text-white/50 text-sm py-2">
                  Aucun message pour l'instant
                </p>
              )}
            </div>
          </div>

          {/* Chat input */}
          <form onSubmit={handleSendMessage} className="px-3 pt-2 bg-gradient-to-t from-black/80 to-transparent pointer-events-auto" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}>
            <div className="flex gap-2">
              <Input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Message..."
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
