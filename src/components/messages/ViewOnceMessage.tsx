import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, Loader2, Lock, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  openAegisViewOnce,
  subscribeViewOnceConsumption,
} from '@/lib/messaging/aegisViewOnce';

interface ViewOnceMessageProps {
  messageId: string;
  isMe: boolean;
  state?: 'pending' | 'consumed' | 'sent';
  onConsumed?: (messageId: string) => void;
}

export function ViewOnceMessage({
  messageId,
  isMe,
  state = isMe ? 'sent' : 'pending',
  onConsumed,
}: ViewOnceMessageProps) {
  const [status, setStatus] = useState(state);
  const [busy, setBusy] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [isVideo, setIsVideo] = useState(false);

  const closeViewer = useCallback(() => {
    setObjectUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  }, []);

  useEffect(() => {
    setStatus(state);
  }, [state]);

  useEffect(() => subscribeViewOnceConsumption((consumedId) => {
    if (consumedId !== messageId) return;
    setStatus('consumed');
    closeViewer();
    onConsumed?.(messageId);
  }), [closeViewer, messageId, onConsumed]);

  useEffect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  const open = async () => {
    if (busy || isMe || status !== 'pending') return;
    setBusy(true);
    try {
      const result = await openAegisViewOnce(messageId);
      if (result.status === 'opened') {
        const url = URL.createObjectURL(result.blob);
        setIsVideo(result.isVideo);
        setObjectUrl(url);
        setStatus('consumed');
        onConsumed?.(messageId);
        return;
      }
      if (result.status === 'consumed') {
        setStatus('consumed');
        onConsumed?.(messageId);
        toast.info('Ce média a déjà été ouvert.');
        return;
      }
      if (result.status === 'claimed_elsewhere') {
        toast.info('Ce média est en cours d’ouverture sur un autre appareil.');
        return;
      }
      if (result.status === 'sender') {
        setStatus('sent');
        return;
      }
      toast.error(result.status === 'error' ? result.reason : 'Média à vue unique indisponible.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        disabled={busy || isMe || status !== 'pending'}
        className={cn(
          'flex min-w-[190px] items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-xs',
          isMe ? 'bg-primary text-primary-foreground' : 'bg-secondary',
          !isMe && status === 'pending' && 'hover:bg-secondary/80',
        )}
      >
        <span className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
          isMe ? 'bg-primary-foreground/15' : 'bg-primary/10 text-primary',
        )}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : status === 'pending' ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">
            {isMe ? 'Média à vue unique envoyé' : status === 'pending' ? 'Ouvrir le média' : 'Média déjà ouvert'}
          </span>
          <span className={cn('block text-[10px]', isMe ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
            {status === 'pending' && !isMe ? 'Une seule ouverture sur un appareil' : 'Le contenu n’est plus disponible'}
          </span>
        </span>
        <Lock className="h-3.5 w-3.5 shrink-0 opacity-70" />
      </button>

      {objectUrl && (
        <div className="fixed inset-0 z-[240] flex items-center justify-center bg-black/95 p-3">
          <button
            type="button"
            onClick={closeViewer}
            className="absolute right-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
            aria-label="Fermer le média à vue unique"
          >
            <X className="h-5 w-5" />
          </button>
          {isVideo ? (
            <video
              src={objectUrl}
              controls
              autoPlay
              playsInline
              controlsList="nodownload noplaybackrate"
              disablePictureInPicture
              className="max-h-[94vh] max-w-[96vw] rounded-xl"
            />
          ) : (
            <img
              src={objectUrl}
              alt="Média à vue unique"
              draggable={false}
              className="max-h-[94vh] max-w-[96vw] select-none rounded-xl object-contain"
            />
          )}
        </div>
      )}
    </>
  );
}
