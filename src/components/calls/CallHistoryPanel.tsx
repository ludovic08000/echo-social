import { Phone, PhoneIncoming, PhoneOutgoing, PhoneMissed, Video, X } from 'lucide-react';
import { useCallHistory } from '@/hooks/useCallHistory';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { cn } from '@/lib/utils';

interface Props {
  conversationId?: string;
  onCallBack?: (peerId: string, type: 'audio' | 'video') => void;
  onClose?: () => void;
}

function fmtDur(s: number) {
  if (s <= 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function CallHistoryPanel({ conversationId, onCallBack, onClose }: Props) {
  const { entries, loading } = useCallHistory(conversationId, 50);

  return (
    <div className="flex flex-col h-full bg-card">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/40">
        <h3 className="text-sm font-semibold">Historique d'appels</h3>
        {onClose && (
          <Button size="icon" variant="ghost" onClick={onClose} className="h-7 w-7">
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && entries.length === 0 && (
          <div className="p-6 text-center text-xs text-muted-foreground">Chargement…</div>
        )}
        {!loading && entries.length === 0 && (
          <div className="p-6 text-center text-xs text-muted-foreground">Aucun appel récent</div>
        )}
        <ul className="divide-y divide-border/30">
          {entries.map(e => {
            const Icon = e.was_missed
              ? PhoneMissed
              : e.is_outgoing
                ? PhoneOutgoing
                : PhoneIncoming;
            const iconColor = e.was_missed ? 'text-destructive' : e.is_outgoing ? 'text-emerald-500' : 'text-primary';
            return (
              <li key={e.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-accent/30">
                <UserAvatar src={e.peer_avatar} alt={e.peer_name || ''} size="sm" />
                <div className="flex-1 min-w-0">
                  <div className={cn('text-sm font-medium truncate', e.was_missed && 'text-destructive')}>
                    {e.peer_name}
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <Icon className={cn('w-3 h-3', iconColor)} />
                    <span>
                      {e.was_missed
                        ? 'Manqué'
                        : e.is_outgoing
                          ? 'Sortant'
                          : 'Entrant'}
                    </span>
                    <span>·</span>
                    <span>{fmtDur(e.duration_seconds)}</span>
                    <span>·</span>
                    <span>{formatDistanceToNow(new Date(e.ended_at), { addSuffix: true, locale: fr })}</span>
                  </div>
                </div>
                {onCallBack && e.peer_id && (
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => onCallBack(e.peer_id!, 'audio')}
                      className="h-8 w-8 text-primary"
                      title="Rappeler audio"
                    >
                      <Phone className="w-4 h-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => onCallBack(e.peer_id!, 'video')}
                      className="h-8 w-8 text-primary"
                      title="Rappeler vidéo"
                    >
                      <Video className="w-4 h-4" />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
