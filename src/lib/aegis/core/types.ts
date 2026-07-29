
import type {
  OutboxExtra,
  OutboxPayload,
} from '@/lib/messaging/outboxVault';
import type { FanoutCopyRow } from '@/lib/messaging/multiDeviceFanout';

export type { FanoutCopyRow, OutboxExtra, OutboxPayload };

export interface AegisOutboundInput {
  conversationId: string;
  senderUserId: string;
  plaintext: string;
  imageUrl?: string | null;
  extra?: OutboxExtra;
  localId?: string;
  traceId?: string;
  messageId?: string;
  createdAt?: number;
  resumePayload?: OutboxPayload | null;
  onState?: (payload: OutboxPayload) => void | Promise<void>;
}

export interface AegisOutboundResult {
  id: string;
  parentBody: string;
  transportPlaintext: string;
  copies: FanoutCopyRow[];
  retriedStaleRoute: boolean;
  localId: string;
  traceId: string;
}
