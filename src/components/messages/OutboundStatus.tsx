import { AegisMessageMetadata } from './AegisMessageMetadata';
import type { OutboxStatus as OutboundMessageStatus } from '@/lib/messaging/outboxVault';

interface OutboundStatusProps {
  status: OutboundMessageStatus;
  lastError?: string | null;
  onRetry?: () => void;
  onRemove?: () => void;
  className?: string;
}

/**
 * Compatibility wrapper for the existing queue UI.
 * The actual rendering is provided by AegisMessageMetadata, adapted from
 * Signal Desktop's AGPL-licensed MessageMetadata component.
 */
export function OutboundStatusIndicator({
  status,
  lastError,
  onRetry,
  onRemove,
  className,
}: OutboundStatusProps) {
  return (
    <AegisMessageMetadata
      direction="outgoing"
      status={status}
      encrypted
      compact
      lastError={lastError}
      onRetry={onRetry}
      onRemove={onRemove}
      className={className}
    />
  );
}
