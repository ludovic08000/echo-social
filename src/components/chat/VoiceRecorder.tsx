import { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, Square, Trash2, Send, Loader2, X, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';

// Detect best supported audio mimeType across browsers
// Prioritize mp4/aac for maximum cross-platform playback (iOS requires it)
function getSupportedMimeType(): { mimeType: string; ext: string } {
  if (typeof MediaRecorder === 'undefined') {
    return { mimeType: '', ext: 'mp4' };
  }
  const types = [
    // MP4/AAC first — universally playable on iOS, Android, Windows, Mac
    { mimeType: 'audio/mp4', ext: 'mp4' },
    { mimeType: 'audio/aac', ext: 'aac' },
    { mimeType: 'audio/mp4;codecs=mp4a.40.2', ext: 'mp4' },
    // WebM/Opus — works on Chrome, Firefox, Android but NOT iOS Safari
    { mimeType: 'audio/webm;codecs=opus', ext: 'webm' },
    { mimeType: 'audio/webm', ext: 'webm' },
    // Ogg — works on Chrome, Firefox but NOT iOS/Safari
    { mimeType: 'audio/ogg;codecs=opus', ext: 'ogg' },
    { mimeType: 'audio/ogg', ext: 'ogg' },
    // WAV — large but universally playable
    { mimeType: 'audio/wav', ext: 'wav' },
    // Fallback: let browser choose
    { mimeType: '', ext: 'mp4' },
  ];
  for (const t of types) {
    if (t.mimeType === '' || MediaRecorder.isTypeSupported(t.mimeType)) {
      return t;
    }
  }
  return types[types.length - 1];
}

interface VoiceRecorderProps {
  onSend: (audioUrl: string, duration: number, encryptedBody?: string) => void;
  onCancel: () => void;
}

export function VoiceRecorder({ onSend, onCancel }: VoiceRecorderProps) {
  const { user } = useAuth();
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [permError, setPermError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const streamRef = useRef<MediaStream | null>(null);

  const startRecording = useCallback(async () => {
    // Check API availability
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const msg = 'Votre navigateur ne supporte pas l\'enregistrement audio. Utilisez Chrome, Safari ou Edge.';
      setPermError(msg);
      toast.error(msg);
      return;
    }

    if (typeof MediaRecorder === 'undefined') {
      const msg = 'MediaRecorder non disponible sur ce navigateur.';
      setPermError(msg);
      toast.error(msg);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const { mimeType, ext } = getSupportedMimeType();

      const recorderOptions: MediaRecorderOptions = {};
      if (mimeType) {
        recorderOptions.mimeType = mimeType;
      }

      let mediaRecorder: MediaRecorder;
      try {
        mediaRecorder = new MediaRecorder(stream, recorderOptions);
      } catch {
        // Fallback: no options
        mediaRecorder = new MediaRecorder(stream);
      }

      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const actualMime = mediaRecorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: actualMime });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach(t => t.stop());
      };

      mediaRecorder.onerror = () => {
        toast.error('Erreur pendant l\'enregistrement');
        setIsRecording(false);
        stream.getTracks().forEach(t => t.stop());
      };

      // Safari sometimes needs a larger timeslice
      mediaRecorder.start(250);
      setIsRecording(true);
      setPermError(null);
      setDuration(0);
      timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
    } catch (err: any) {
      const inPreviewIframe = window.self !== window.top;
      let msg = 'Impossible d\'accéder au micro';

      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        msg = inPreviewIframe
          ? 'Le micro est bloqué en mode preview. Ouvrez la version publiée et autorisez le micro.'
          : 'Micro bloqué. Cliquez sur l’icône cadenas (barre d’adresse) puis autorisez le micro.';
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        msg = 'Aucun microphone détecté sur cet appareil';
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        msg = 'Le micro est utilisé par une autre application';
      } else if (err.name === 'OverconstrainedError') {
        msg = 'Impossible de trouver un micro compatible';
      } else if (err.name === 'SecurityError') {
        msg = inPreviewIframe
          ? 'Le micro est bloqué en preview. Testez depuis la version publiée.'
          : 'Accès au micro bloqué (HTTPS requis).';
      }

      setPermError(msg);
      toast.error(msg);
      console.error('Microphone access error:', err.name, err.message);
    }
  }, []);

  const stopRecording = useCallback(() => {
    clearInterval(timerRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  const handleSend = useCallback(async () => {
    if (!audioBlob || !user) return;
    setUploading(true);
    try {
      let ext = 'mp4';
      const blobType = audioBlob.type.split(';')[0].trim();
      if (blobType.includes('webm')) ext = 'webm';
      else if (blobType.includes('ogg')) ext = 'ogg';
      else if (blobType.includes('wav')) ext = 'wav';
      else if (blobType.includes('aac')) ext = 'aac';
      else if (blobType.includes('mp4') || blobType.includes('m4a')) ext = 'mp4';

      // ─── E2EE: encrypt voice blob before upload ───
      const { generateMediaKey, encryptMedia, buildMediaMessageBody } = await import('@/lib/crypto/mediaEncrypt');
      const { key, keyB64 } = await generateMediaKey();
      const encryptedBlob = await encryptMedia(audioBlob, key);

      const { uploadToR2 } = await import('@/lib/r2');
      const { url } = await uploadToR2(encryptedBlob, 'voice', `voice-${Date.now()}.enc.${ext}`);

      // Build message body with embedded media key (will be E2EE-encrypted by the message queue)
      const label = `🎙️ vocal:${url}|${duration}`;
      const body = buildMediaMessageBody(label, keyB64);
      onSend(url, duration, body);
    } catch (err: any) {
      console.error('Voice upload error:', err?.message || err);
      toast.error(`Erreur lors de l'envoi du vocal: ${err?.message || 'Réessayez'}`);
    } finally {
      setUploading(false);
    }
  }, [audioBlob, user, duration, onSend]);

  const handleDiscard = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    clearInterval(timerRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setAudioBlob(null);
    setAudioUrl(null);
    setDuration(0);
    setIsRecording(false);
    onCancel();
  };

  useEffect(() => {
    // Auto-start recording immediately on mount (triggered by user click on mic button)
    startRecording();
    return () => {
      clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch {}
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  if (permError) {
    return (
      <div className="flex items-center gap-2 px-2.5 py-2 border-t border-border/30 bg-destructive/5">
        <div className="flex-1 text-[11px] text-destructive">{permError}</div>
        <button
          type="button"
          onClick={startRecording}
          className="text-[11px] px-2 py-1 rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors"
        >
          Réessayer
        </button>
        <button
          type="button"
          onClick={handleDiscard}
          className="text-[11px] text-muted-foreground hover:text-foreground px-2 py-1"
        >
          Fermer
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-2.5 py-2 border-t border-border/30 bg-destructive/5">
      <button
        onClick={handleDiscard}
        className="w-7 h-7 rounded-full flex items-center justify-center text-destructive hover:bg-destructive/10 transition-colors"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>

      <div className="flex-1 flex items-center gap-2">
        {isRecording ? (
          <>
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
              <span className="text-[11px] font-mono font-medium text-destructive">{formatDuration(duration)}</span>
            </div>
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
          <div className="flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">Autorisation du micro…</span>
          </div>
        )}
      </div>

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

// ─── Voice Message Player ───────────────────────────────
interface VoiceMessagePlayerProps {
  audioUrl: string;
  duration?: number;
  isMe?: boolean;
  mediaKeyB64?: string;
}

export function VoiceMessagePlayer({ audioUrl, duration, isMe, mediaKeyB64 }: VoiceMessagePlayerProps) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(duration || 0);
  const [blobSrc, setBlobSrc] = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  const [rate, setRate] = useState<1 | 1.5 | 2>(1);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const triedBlobRef = useRef(false);

  const handleTranscribe = useCallback(async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (transcribing || transcript) return;
    setTranscribing(true);
    try {
      const { transcribeVoice } = await import('@/lib/messaging/transcribeVoice');
      // Prefer the in-memory blob (decrypted), fallback to fetching the URL.
      let blob: Blob | null = null;
      if (blobSrc) {
        try { blob = await (await fetch(blobSrc)).blob(); } catch { blob = null; }
      }
      if (!blob && !mediaKeyB64) {
        try { blob = await (await fetch(audioUrl)).blob(); } catch { blob = null; }
      }
      if (!blob) { toast.error('Vocal indisponible'); return; }
      const t = await transcribeVoice(blob);
      if (!t) { toast.error('Transcription échouée'); return; }
      setTranscript(t);
    } finally {
      setTranscribing(false);
    }
  }, [transcribing, transcript, blobSrc, audioUrl, mediaKeyB64]);

  // ─── E2EE: Decrypt encrypted voice on mount ───
  useEffect(() => {
    if (!mediaKeyB64) return; // Not encrypted, use URL directly
    let cancelled = false;
    setDecrypting(true);

    (async () => {
      try {
        const { importMediaKey, decryptMedia } = await import('@/lib/crypto/mediaEncrypt');
        const key = await importMediaKey(mediaKeyB64);
        const res = await fetch(audioUrl);
        if (!res.ok) throw new Error('fetch failed');
        const encryptedData = await res.arrayBuffer();
        const plainAudio = await decryptMedia(encryptedData, key);

        if (cancelled) return;
        // Guess mime from URL extension
        let mime = 'audio/mp4';
        if (audioUrl.includes('.webm')) mime = 'audio/webm';
        else if (audioUrl.includes('.ogg')) mime = 'audio/ogg';
        else if (audioUrl.includes('.wav')) mime = 'audio/wav';

        const blob = new Blob([plainAudio], { type: mime });
        setBlobSrc(URL.createObjectURL(blob));
      } catch (err) {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setDecrypting(false);
      }
    })();

    return () => { cancelled = true; };
  }, [audioUrl, mediaKeyB64]);

  // On iOS Safari, webm URLs won't play via <audio src>.
  // Fallback: fetch as blob and create an object URL, which sometimes works
  // for formats the browser can partially decode.
  const tryBlobFallback = useCallback(async () => {
    if (triedBlobRef.current || mediaKeyB64) return; // Skip if encrypted (already handled)
    triedBlobRef.current = true;
    try {
      const res = await fetch(audioUrl);
      if (!res.ok) throw new Error('fetch failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setBlobSrc(url);
      setError(false);
    } catch {
      setError(true);
    }
  }, [audioUrl, mediaKeyB64]);

  const togglePlay = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!audioRef.current || error) return;

    const audio = audioRef.current;

    if (audio.paused) {
      if (audio.duration && audio.currentTime >= audio.duration - 0.05) {
        audio.currentTime = 0;
      }
      audio.muted = false;
      audio.volume = 1;
      audio.play().catch((err) => {
        console.error('Voice playback error:', err);
        // Try blob fallback before giving up
        if (!triedBlobRef.current) {
          tryBlobFallback();
        } else {
          setError(true);
          toast.error('Impossible de lire ce vocal');
        }
      });
      return;
    }
    audio.pause();
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => {
      setProgress(audio.currentTime / (audio.duration || 1));
      setCurrentTime(audio.currentTime);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnd = () => { setPlaying(false); setProgress(0); setCurrentTime(0); };
    const onError = () => {
      setPlaying(false);
      console.error('Audio element error:', audio.error?.code, audio.error?.message, 'src:', audioUrl);
      // Try blob fallback on first error
      if (!triedBlobRef.current) {
        tryBlobFallback();
      } else {
        setError(true);
      }
    };
    const onLoaded = () => {
      if (audio.duration && isFinite(audio.duration)) {
        setAudioDuration(audio.duration);
      }
      setError(false);
    };

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnd);
    audio.addEventListener('error', onError);
    audio.addEventListener('loadedmetadata', onLoaded);

    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnd);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('loadedmetadata', onLoaded);
    };
  }, [audioUrl, blobSrc, tryBlobFallback]);

  // Cleanup blob URL
  useEffect(() => {
    return () => {
      if (blobSrc) URL.revokeObjectURL(blobSrc);
    };
  }, [blobSrc]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const displayTime = playing ? formatTime(currentTime) : formatTime(audioDuration);
  // For encrypted audio, only use blobSrc (decrypted); for plain audio, use URL directly or blobSrc fallback
  const effectiveSrc = mediaKeyB64 ? (blobSrc || '') : (blobSrc || audioUrl);

  if (decrypting) {
    return (
      <div className={cn(
        "flex items-center gap-2 px-3 py-2 rounded-2xl min-w-[160px]",
        isMe ? "bg-primary text-primary-foreground" : "bg-secondary"
      )}>
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-xs">Déchiffrement...</span>
      </div>
    );
  }

  return (
    <div className={cn(
      "flex items-center gap-2 px-3 py-2 rounded-2xl min-w-[160px]",
      isMe ? "bg-primary text-primary-foreground" : "bg-secondary",
      error && "opacity-60"
    )}>
      <audio ref={audioRef} src={effectiveSrc} preload="metadata" playsInline />
      
      <button
        onClick={togglePlay}
        disabled={error}
        className={cn(
          "w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 transition-colors",
          isMe ? "bg-primary-foreground/20 hover:bg-primary-foreground/30" : "bg-primary/10 hover:bg-primary/20",
          error && "cursor-not-allowed"
        )}
      >
        {error ? (
          <X className={cn("w-2.5 h-2.5", isMe ? "text-primary-foreground" : "text-destructive")} />
        ) : playing ? (
          <Square className={cn("w-2.5 h-2.5 fill-current", isMe ? "text-primary-foreground" : "text-primary")} />
        ) : (
          <svg className={cn("w-3 h-3", isMe ? "text-primary-foreground" : "text-primary")} viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5,3 19,12 5,21" />
          </svg>
        )}
      </button>

      <div className="flex-1 flex flex-col gap-0.5">
        {error ? (
          <span className={cn("text-[10px]", isMe ? "text-primary-foreground/70" : "text-muted-foreground")}>
            Format non supporté sur cet appareil
          </span>
        ) : (
          <>
            <div className={cn("h-1 rounded-full overflow-hidden", isMe ? "bg-primary-foreground/20" : "bg-border")}>
              <div
                className={cn("h-full rounded-full transition-all", isMe ? "bg-primary-foreground/70" : "bg-primary/60")}
                style={{ width: `${progress * 100}%` }}
              />
            </div>
            <span className={cn("text-[9px]", isMe ? "text-primary-foreground/70" : "text-muted-foreground")}>
              {displayTime}
            </span>
          </>
        )}
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
          setRate(next as 1 | 1.5 | 2);
          if (audioRef.current) audioRef.current.playbackRate = next;
        }}
        title="Vitesse de lecture"
        className={cn(
          "text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full flex-shrink-0 transition-colors",
          isMe
            ? "bg-primary-foreground/20 text-primary-foreground hover:bg-primary-foreground/30"
            : "bg-primary/10 text-primary hover:bg-primary/20"
        )}
      >
        {rate}×
      </button>
      <Mic className={cn("w-3 h-3 flex-shrink-0", isMe ? "text-primary-foreground/50" : "text-muted-foreground/50")} />
    </div>
  );
}
