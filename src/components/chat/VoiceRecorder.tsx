import { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, Square, Trash2, Send, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

interface VoiceRecorderProps {
  onSend: (audioUrl: string, duration: number) => void;
  onCancel: () => void;
}

export function VoiceRecorder({ onSend, onCancel }: VoiceRecorderProps) {
  const { user } = useAuth();
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const streamRef = useRef<MediaStream | null>(null);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach(t => t.stop());
      };

      mediaRecorder.start(100);
      setIsRecording(true);
      setDuration(0);
      timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
    } catch (err) {
      console.error('Microphone access denied:', err);
    }
  }, []);

  const stopRecording = useCallback(() => {
    clearInterval(timerRef.current);
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }, []);

  const handleSend = useCallback(async () => {
    if (!audioBlob || !user) return;
    setUploading(true);
    try {
      const fileName = `${user.id}/voice-${Date.now()}.webm`;
      const { error: uploadError } = await supabase.storage
        .from('post-images')
        .upload(fileName, audioBlob, { contentType: 'audio/webm' });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from('post-images')
        .getPublicUrl(fileName);

      onSend(urlData.publicUrl, duration);
    } catch (err) {
      console.error('Voice upload error:', err);
    } finally {
      setUploading(false);
    }
  }, [audioBlob, user, duration, onSend]);

  const handleDiscard = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioBlob(null);
    setAudioUrl(null);
    setDuration(0);
    onCancel();
  };

  useEffect(() => {
    // Auto-start recording on mount
    startRecording();
    return () => {
      clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex items-center gap-2 px-2.5 py-2 border-t border-border/30 bg-destructive/5">
      {/* Discard */}
      <button
        onClick={handleDiscard}
        className="w-7 h-7 rounded-full flex items-center justify-center text-destructive hover:bg-destructive/10 transition-colors"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>

      {/* Waveform / status */}
      <div className="flex-1 flex items-center gap-2">
        {isRecording ? (
          <>
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
              <span className="text-[11px] font-mono font-medium text-destructive">{formatDuration(duration)}</span>
            </div>
            {/* Fake waveform animation */}
            <div className="flex items-center gap-[2px] flex-1">
              {Array.from({ length: 20 }).map((_, i) => (
                <div
                  key={i}
                  className="w-[3px] rounded-full bg-destructive/60"
                  style={{
                    height: `${8 + Math.random() * 14}px`,
                    animationDelay: `${i * 0.05}s`,
                    animation: 'pulse 0.8s ease-in-out infinite alternate',
                  }}
                />
              ))}
            </div>
          </>
        ) : audioUrl ? (
          <div className="flex items-center gap-2 flex-1">
            <span className="text-[11px] font-mono text-muted-foreground">{formatDuration(duration)}</span>
            <audio src={audioUrl} controls className="h-7 flex-1" style={{ maxWidth: '150px' }} />
          </div>
        ) : (
          <span className="text-[11px] text-muted-foreground">Préparation…</span>
        )}
      </div>

      {/* Stop / Send */}
      {isRecording ? (
        <button
          onClick={stopRecording}
          className="w-8 h-8 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center hover:bg-destructive/90 transition-colors"
        >
          <Square className="w-3 h-3 fill-current" />
        </button>
      ) : audioBlob ? (
        <button
          onClick={handleSend}
          disabled={uploading}
          className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 transition-colors"
        >
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
        </button>
      ) : null}
    </div>
  );
}

// Voice message player component for displaying in messages
interface VoiceMessagePlayerProps {
  audioUrl: string;
  duration?: number;
  isMe?: boolean;
}

export function VoiceMessagePlayer({ audioUrl, duration, isMe }: VoiceMessagePlayerProps) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (playing) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setPlaying(!playing);
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => setProgress(audio.currentTime / (audio.duration || 1));
    const onEnd = () => { setPlaying(false); setProgress(0); };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnd);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnd);
    };
  }, []);

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className={cn(
      "flex items-center gap-2 px-3 py-2 rounded-2xl min-w-[160px]",
      isMe ? "bg-primary text-primary-foreground" : "bg-secondary"
    )}>
      <audio ref={audioRef} src={audioUrl} preload="metadata" />
      
      <button
        onClick={togglePlay}
        className={cn(
          "w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 transition-colors",
          isMe ? "bg-primary-foreground/20 hover:bg-primary-foreground/30" : "bg-primary/10 hover:bg-primary/20"
        )}
      >
        {playing ? (
          <Square className={cn("w-2.5 h-2.5 fill-current", isMe ? "text-primary-foreground" : "text-primary")} />
        ) : (
          <svg className={cn("w-3 h-3", isMe ? "text-primary-foreground" : "text-primary")} viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5,3 19,12 5,21" />
          </svg>
        )}
      </button>

      {/* Progress bar */}
      <div className="flex-1 flex flex-col gap-0.5">
        <div className={cn("h-1 rounded-full overflow-hidden", isMe ? "bg-primary-foreground/20" : "bg-border")}>
          <div
            className={cn("h-full rounded-full transition-all", isMe ? "bg-primary-foreground/70" : "bg-primary/60")}
            style={{ width: `${progress * 100}%` }}
          />
        </div>
        <span className={cn("text-[9px]", isMe ? "text-primary-foreground/70" : "text-muted-foreground")}>
          {duration ? formatDuration(duration) : '0:00'}
        </span>
      </div>

      {/* Mic icon */}
      <Mic className={cn("w-3 h-3 flex-shrink-0", isMe ? "text-primary-foreground/50" : "text-muted-foreground/50")} />
    </div>
  );
}
