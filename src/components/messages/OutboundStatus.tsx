import { type OutboundMessageStatus } from '@/lib/messaging/messageQueue';
import { AlertTriangle, Clock, Loader2, RefreshCw, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface OutboundStatusProps {
  status: OutboundMessageStatus;
  lastError?: string | null;
  onRetry?: () => void;
  onRemove?: () => void;
  className?: string;
}

function statusLabel(status: OutboundMessageStatus, lastError?: string | null): string {
  if (status === 'encrypting') return 'Chiffrement...';
  if (status === 'sending') return 'Envoi...';
  if (status === 'waiting_secure_channel') return 'Canal securise en attente';
  if (status === 'retry_pending') return 'Nouvel essai en attente';
  if (status === 'failed_visible') {
    if (lastError === 'secure_channel_blocked') {
      return 'Cle de securite modifiee - verification obligatoire';
    }
    if (lastError === 'secure_channel_unavailable') {
      return 'Canal securise indisponible';
    }
    if (lastError === 'secure_encrypt_unavailable') {
      return 'Chiffrement impossible';
    }
    return 'Message non envoye';
  }
  return 'En attente';
}

function statusIcon(status: OutboundMessageStatus) {
  if (status === 'failed_visible') return AlertTriangle;
  if (status === 'encrypting' || status === 'sending') return Loader2;
  return Clock;
}

export function OutboundStatusIndicator({
  status,
  lastError,
  onRetry,
  onRemove,
  className,
}: OutboundStatusProps) {
  if (status === 'sent') return null;

  const Icon = statusIcon(status);
  const failed = status === 'failed_visible';

  return (
    <div
      className={cn(
        'mt-1 flex items-center justify-end gap-1 text-[10px]',
        failed ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground',
        className,
      )}
    >
      <Icon className={cn('h-3 w-3 flex-shrink-0', status !== 'failed_visible' && (status === 'encrypting' || status === 'sending') && 'animate-spin')} />
      <span className="min-w-0 truncate">{statusLabel(status, lastError)}</span>
      {failed && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-amber-500/10"
          title="Reessayer"
          aria-label="Reessayer"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      )}
      {failed && onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-amber-500/10"
          title="Supprimer"
          aria-label="Supprimer"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
