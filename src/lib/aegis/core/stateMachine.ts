
import type { OutboxStatus } from '@/lib/messaging/outboxVault';

export const AEGIS_OUTBOX_TRANSITIONS = {
  draft: ['pending_local', 'failed_visible'],
  pending_local: ['encrypting', 'sending', 'failed_visible'],
  encrypting: ['waiting_secure_channel', 'sending', 'retry_pending', 'failed_visible'],
  waiting_secure_channel: ['encrypting', 'retry_pending', 'failed_visible'],
  sending: ['sent', 'retry_pending', 'waiting_secure_channel', 'failed_visible'],
  sent: [],
  retry_pending: ['encrypting', 'sending', 'waiting_secure_channel', 'failed_visible'],
  failed_visible: ['pending_local', 'encrypting', 'sending'],
} as const satisfies Record<OutboxStatus, readonly OutboxStatus[]>;

export function canTransitionAegisOutbox(
  from: OutboxStatus,
  to: OutboxStatus,
): boolean {
  if (from === to) return true;
  return (AEGIS_OUTBOX_TRANSITIONS[from] as readonly OutboxStatus[]).includes(to);
}

export function assertAegisOutboxTransition(
  from: OutboxStatus,
  to: OutboxStatus,
): void {
  if (!canTransitionAegisOutbox(from, to)) {
    throw new Error(`AEGIS_INVALID_OUTBOX_TRANSITION:${from}->${to}`);
  }
}
