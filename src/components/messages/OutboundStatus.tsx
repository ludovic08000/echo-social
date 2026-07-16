import { SesameMessageMetadata } from './SesameMessageMetadata';
import type { OutboundMessageStatus } from '@/lib/messaging/messageQueue';

interface OutboundStatusProps {
  status: OutboundMessageStatus;
  lastError?: string | null;
  onRetry?: () => void;
  onRemove?: () => void;
  className?: string;
}

/**
 * Compatibility wrapper for the existing queue UI.
 * The actual rendering is provided by SesameMessageMetadata, adapted from
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
    <SesameMessageMetadata
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
