import { type OutboundMessageStatus } from '@/lib/messaging/messageQueue';

interface OutboundStatusProps {
  status: OutboundMessageStatus;
  lastError?: string | null;
  onRetry?: () => void;
  onRemove?: () => void;
  className?: string;
}

export function OutboundStatusIndicator(_props: OutboundStatusProps) {
  return null;
}
