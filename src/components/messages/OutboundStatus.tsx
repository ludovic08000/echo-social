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
  encrypting: 'Chiffrement…',
  sending: 'Envoi…',
  waiting_secure_channel: 'Envoi en cours…',
  retry_pending: 'Nouvelle tentative…',
  sent: 'Envoyé · chiffré',
  failed_visible: 'Échec d\'envoi',
};

export function OutboundStatusIndicator({ status, lastError, onRetry, onRemove, className }: OutboundStatusProps) {
  // Error state — prominent
  if (status === 'failed_visible') {
    return (
      <div className={cn(
        'flex items-center gap-1.5 mt-0.5 px-1 text-destructive',
        className,
      )}>
        <AlertTriangle className="w-3 h-3" />
        <span className="text-[10px] font-medium">
          {STATUS_LABELS.failed_visible}
        </span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="text-[10px] font-semibold text-primary underline underline-offset-2 ml-1"
          >
            Réessayer
          </button>
        )}
        {onRemove && (
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

  // Sent — discreet check + lock
  if (status === 'sent') {
    return (
      <div className={cn('flex items-center gap-1 mt-0.5 px-1 text-muted-foreground/80', className)}>
        <Check className="w-3 h-3" />
        <Lock className="w-2.5 h-2.5" />
        <span className="text-[10px]">{STATUS_LABELS.sent}</span>
      </div>
    );
  }

  // In-flight states — subtle spinner / clock
  const isEncrypting = status === 'encrypting';
  const Icon = isEncrypting ? Lock : status === 'retry_pending' ? RefreshCw : Clock;
  const label = STATUS_LABELS[status] ?? '';
  if (!label) return null;

  return (
    <div className={cn('flex items-center gap-1 mt-0.5 px-1 text-muted-foreground/70', className)}>
      <Icon className={cn('w-3 h-3', status === 'retry_pending' && 'animate-spin')} />
      <span className="text-[10px] italic">{label}</span>
      {onRetry && (
        <button
          onClick={onRetry}
          className="text-[10px] font-semibold text-primary underline underline-offset-2 ml-1"
        >
          Réessayer
        </button>
      )}
      {onRemove && (
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
