import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, Send, Radio, StopCircle, Save } from 'lucide-react';
import { LiveEmojiPicker } from './LiveEmojiPicker';
import { LiveStreamPlayer, LiveStreamPlayerRef } from './LiveStreamPlayer';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLiveChat, useSendLiveChatMessage, useEndLive } from '@/hooks/useLiveStreams';
import { toast } from '@/hooks/use-toast';
import { LiveStream } from '@/hooks/useLiveStreams';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

interface HostLiveViewProps {
  live: LiveStream;
}

export function HostLiveView({ live }: HostLiveViewProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const playerRef = useRef<LiveStreamPlayerRef>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const [message, setMessage] = useState('');
  const [isEnding, setIsEnding] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isSavingRecording, setIsSavingRecording] = useState(false);
  
  const { data: chatMessages } = useLiveChat(live.id);
  const sendMessage = useSendLiveChatMessage();
  const endLive = useEndLive();

  // Auto-start recording when stream is ready
  const startRecording = (stream: MediaStream) => {
    try {
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
          ? 'video/webm;codecs=vp8,opus'
          : MediaRecorder.isTypeSupported('video/webm')
            ? 'video/webm'
            : 'video/mp4';

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      recordedChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunksRef.current.push(e.data);
        }
      };

      recorder.onerror = () => {
        console.error('MediaRecorder error');
        setIsRecording(false);
      };

      recorder.onstop = () => {
        setIsRecording(false);
      };

      recorder.start(1000); // Collect data every second
      setIsRecording(true);
    } catch (err) {
      console.error('Failed to start recording:', err);
    }
  };

  const saveRecording = async (): Promise<string | null> => {
    if (recordedChunksRef.current.length === 0 || !user) return null;

    setIsSavingRecording(true);
    try {
      const mimeType = mediaRecorderRef.current?.mimeType || 'video/webm';
      const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(recordedChunksRef.current, { type: mimeType });
      
      if (blob.size < 1000) return null;

      const { uploadToR2 } = await import('@/lib/r2');
      const { url } = await uploadToR2(blob, 'lives', `live-${live.id}-${Date.now()}.${ext}`);

      await supabase
        .from('live_streams')
        .update({ recording_url: url } as any)
        .eq('id', live.id);

      return url;
    } catch (err) {
      console.error('Save recording error:', err);
      return null;
    } finally {
      setIsSavingRecording(false);
    }
  };

  // Auto-scroll chat
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const handleStreamReady = (stream?: MediaStream) => {
    if (stream && stream.getTracks().length > 0) {
      startRecording(stream);
    } else {
      console.warn('No MediaStream provided for recording');
    }
  };

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
      // Stop recording first
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }

      // Wait a moment for the last chunks
      await new Promise(resolve => setTimeout(resolve, 500));

      // Save the recording
      const recordingUrl = await saveRecording();

      playerRef.current?.stopStream();
      await endLive.mutateAsync(live.id);

      // Auto-publish a post with the recording in the feed
      if (recordingUrl && user) {
        const hashtagsText = live.hashtags?.length 
          ? '\n' + live.hashtags.map(t => `#${t}`).join(' ') 
          : '';
        await supabase.from('posts').insert({
          user_id: user.id,
          body: `🔴 ${live.title}${hashtagsText}`,
          image_url: recordingUrl,
        });
      }
      
      toast({ 
        title: recordingUrl ? 'Live terminé et publié dans le feed ! 🎬' : 'Live terminé !' 
      });
      navigate('/feed');
    } catch (error) {
      toast({ title: 'Erreur', variant: 'destructive' });
      setIsEnding(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black flex flex-col">
      {/* Video — full screen */}
      <div className="flex-1 relative">
        <div className="live-host-video w-full h-full">
          <LiveStreamPlayer 
            ref={playerRef}
            isHost={true}
            roomName={`live-${live.id}`}
            className="w-full h-full"
            onStreamReady={handleStreamReady}
          />
        </div>

        {/* Top overlay */}
        <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/60 to-transparent pointer-events-none z-10">
          <div className="flex items-center justify-between pointer-events-auto">
            <button 
              onClick={handleEndLive}
              disabled={isEnding || isSavingRecording}
              className="flex items-center gap-2 px-4 py-2 rounded-full bg-red-500 text-white font-medium"
            >
              <StopCircle className="w-4 h-4" />
              {isSavingRecording ? 'Sauvegarde...' : isEnding ? 'Fin...' : 'Terminer'}
            </button>

            <div className="flex items-center gap-2">
              {isRecording && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/50 backdrop-blur-sm text-white text-sm">
                  <Save className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400 text-xs">REC</span>
                </div>
              )}
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
