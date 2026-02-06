import { useState, useRef, useEffect } from 'react';
import { Music, Play, Pause, Volume2, VolumeX } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ProfileMusicPlayerProps {
  musicUrl: string | null;
  profileName: string;
}

export function ProfileMusicPlayer({ musicUrl, profileName }: ProfileMusicPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (musicUrl) {
      audioRef.current = new Audio(musicUrl);
      audioRef.current.loop = true;
      audioRef.current.volume = 0.3;
    }
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, [musicUrl]);

  if (!musicUrl) return null;

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(() => {});
    }
    setIsPlaying(!isPlaying);
  };

  const toggleMute = () => {
    if (!audioRef.current) return;
    audioRef.current.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  return (
    <div className="premium-card p-3 flex items-center gap-3">
      <div className={cn(
        "w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 transition-all",
        isPlaying ? "bg-primary/15 animate-pulse" : "bg-secondary/60"
      )}>
        <Music className="w-4 h-4 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">🎵 Ambiance de {profileName}</p>
        <p className="text-[10px] text-muted-foreground truncate">{musicUrl}</p>
      </div>
      <div className="flex gap-1">
        <button onClick={toggleMute} className="w-8 h-8 rounded-full hover:bg-secondary/60 flex items-center justify-center transition-colors">
          {isMuted ? <VolumeX className="w-4 h-4 text-muted-foreground" /> : <Volume2 className="w-4 h-4 text-muted-foreground" />}
        </button>
        <button onClick={togglePlay} className="w-8 h-8 rounded-full bg-primary/10 hover:bg-primary/20 flex items-center justify-center transition-colors">
          {isPlaying ? <Pause className="w-4 h-4 text-primary" /> : <Play className="w-4 h-4 text-primary" />}
        </button>
      </div>
    </div>
  );
}
