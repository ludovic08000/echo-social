import { Lock, Clock, Send, Check, RefreshCw, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type OutboundMessageStatus, getStatusLabel, getStatusIcon } from '@/lib/messaging/messageQueue';

interface OutboundStatusProps {
  status: OutboundMessageStatus;
  lastError?: string | null;
  onRetry?: () => void;
  onRemove?: () => void;
  className?: string;
}

const STATUS_LABELS: Record<string, string> = {
  // Intermediate states are kept silent — users should never see "Chiffrement..."
  // or "Envoi..." flicker. Only errors surface.
  encrypting: '',
  sending: '',
  waiting_secure_channel: '',
  retry_pending: '',
  failed_visible: 'Échec d\'envoi',
};

export function OutboundStatusIndicator({ status, lastError, onRetry, onRemove, className }: OutboundStatusProps) {
  if (status === 'sent') return null;
  // Hide all non-error states entirely — encryption/sending happens invisibly.
  if (status !== 'failed_visible') return null;

  const isError = status === 'failed_visible';
  const isWaiting = status === 'waiting_secure_channel' || status === 'retry_pending';

  const IconComponent = isError ? AlertTriangle
    : isWaiting ? Clock
    : status === 'encrypting' ? Lock
    : status === 'sending' ? Send
    : Check;

  return (
    <div className={cn(
      'flex items-center gap-1.5 mt-0.5 px-1',
      isError ? 'text-destructive' : 'text-muted-foreground',
      className,
    )}>
      <IconComponent className={cn(
        'w-3 h-3',
        (status === 'encrypting' || status === 'sending') && 'animate-pulse',
        isWaiting && 'animate-spin',
      )} />
      <span className="text-[10px] font-medium">
        {STATUS_LABELS[status] || status}
      </span>
      {isError && onRetry && (
        <button
          onClick={onRetry}
          className="text-[10px] font-semibold text-primary underline underline-offset-2 ml-1"
        >
          Réessayer
        </button>
      )}
      {(isError || isWaiting) && onRemove && (
        <button
          onClick={onRemove}
          className="text-[10px] font-semibold text-muted-foreground underline underline-offset-2 ml-1"
        >
          Supprimer
        </button>
      )}
    </div>
  );
}
