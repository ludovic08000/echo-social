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

export function OutboundStatusIndicator({ status, lastError, onRetry, onRemove, className }: OutboundStatusProps) {
  if (status === 'sent') return null;

  const icon = getStatusIcon(status);
  const label = getStatusLabel(status);
  const isError = status === 'failed_visible';
  const isWaiting = status === 'waiting_secure_channel' || status === 'retry_pending';
  const canRemove = status !== 'sending' && status !== 'encrypting';

  const IconComponent = {
    lock: Lock,
    clock: Clock,
    send: Send,
    check: Check,
    retry: RefreshCw,
    error: AlertTriangle,
  }[icon];

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
      <span className="text-[10px] font-medium">{label}</span>
      {isError && onRetry && (
        <button
          onClick={onRetry}
          className="text-[10px] font-semibold text-primary underline underline-offset-2 ml-1"
        >
          Réessayer
        </button>
      )}
      {canRemove && onRemove && (
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
