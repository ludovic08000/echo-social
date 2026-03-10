import { useState, useRef, useEffect } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { cn } from '@/lib/utils';

interface VoiceRecordButtonProps {
  onSend: (text: string) => void;
}

export function VoiceRecordButton({ onSend }: VoiceRecordButtonProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  const toggleRecording = () => {
    if (isRecording) {
      clearInterval(timerRef.current);
      onSend(`🎙️ Message vocal (${recordDuration}s)`);
      setRecordDuration(0);
      setIsRecording(false);
    } else {
      setIsRecording(true);
      setRecordDuration(0);
      timerRef.current = setInterval(() => {
        setRecordDuration(d => d + 1);
      }, 1000);
    }
  };

  useEffect(() => {
    return () => clearInterval(timerRef.current);
  }, []);

  return (
    <div className="flex items-center gap-2">
      {isRecording && (
        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-destructive/10 animate-pulse">
          <div className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
          <span className="text-xs font-medium text-destructive tabular-nums">
            {Math.floor(recordDuration / 60)}:{(recordDuration % 60).toString().padStart(2, '0')}
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={toggleRecording}
        className={cn(
          "h-10 w-10 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-300",
          isRecording 
            ? "bg-destructive text-destructive-foreground shadow-lg shadow-destructive/30 scale-110 animate-pulse" 
            : "bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80"
        )}
      >
        {isRecording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
      </button>
    </div>
  );
}
