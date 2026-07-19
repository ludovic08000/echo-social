// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//
// Adapted for the Sesame web messenger on 2026-07-16 from:
// Signal Desktop — ts/messages/MessageSendState.std.ts
// Signal-specific models and memoization dependencies were removed.

import type { OutboxStatus as OutboundMessageStatus } from './outboxVault';

/**
 * Per-recipient delivery state. The order is monotonic: authenticated receipts
 * may move a message forward, but a late event must never move it backwards.
 */
export enum SesameSendStatus {
  Failed = 'Failed',
  Pending = 'Pending',
  Sent = 'Sent',
  Delivered = 'Delivered',
  Read = 'Read',
  Viewed = 'Viewed',
  Skipped = 'Skipped',
}

export const UNDELIVERED_SESAME_SEND_STATUSES = [
  SesameSendStatus.Pending,
  SesameSendStatus.Failed,
] as const;

export type SesameVisibleSendStatus = Exclude<SesameSendStatus, SesameSendStatus.Skipped>;

const STATUS_RANK: Record<SesameSendStatus, number> = {
  [SesameSendStatus.Failed]: 0,
  [SesameSendStatus.Pending]: 1,
  [SesameSendStatus.Sent]: 2,
  [SesameSendStatus.Delivered]: 3,
  [SesameSendStatus.Read]: 4,
  [SesameSendStatus.Viewed]: 5,
  [SesameSendStatus.Skipped]: 6,
};

export function maxSesameSendStatus(
  left: SesameSendStatus,
  right: SesameSendStatus,
): SesameSendStatus {
  return STATUS_RANK[left] > STATUS_RANK[right] ? left : right;
}

export function isSesamePending(status: SesameSendStatus): boolean {
  return status === SesameSendStatus.Pending;
}

export function isSesameViewed(status: SesameSendStatus): boolean {
  return status === SesameSendStatus.Viewed;
}

export function isSesameSent(status: SesameSendStatus): boolean {
  return STATUS_RANK[status] >= STATUS_RANK[SesameSendStatus.Sent];
}

export function isSesameDelivered(status: SesameSendStatus): boolean {
  return STATUS_RANK[status] >= STATUS_RANK[SesameSendStatus.Delivered];
}

export function isSesameRead(status: SesameSendStatus): boolean {
  return STATUS_RANK[status] >= STATUS_RANK[SesameSendStatus.Read];
}

export function isSesameFailed(status: SesameSendStatus): boolean {
  return status === SesameSendStatus.Failed;
}

export type SesameSendState = Readonly<{
  status: SesameSendStatus;
  updatedAt?: number;
}>;

export type SesameSendStateByRecipientId = Readonly<Record<string, SesameSendState>>;

export enum SesameSendActionType {
  Failed,
  ManuallyRetried,
  Sent,
  GotDeliveryReceipt,
  GotReadReceipt,
  GotViewedReceipt,
}

export type SesameSendAction = Readonly<{
  type: SesameSendActionType;
  updatedAt: number | undefined;
}>;

const ACTION_STATUS: Record<SesameSendActionType, SesameSendStatus> = {
  [SesameSendActionType.Failed]: SesameSendStatus.Failed,
  [SesameSendActionType.ManuallyRetried]: SesameSendStatus.Pending,
  [SesameSendActionType.Sent]: SesameSendStatus.Sent,
  [SesameSendActionType.GotDeliveryReceipt]: SesameSendStatus.Delivered,
  [SesameSendActionType.GotReadReceipt]: SesameSendStatus.Read,
  [SesameSendActionType.GotViewedReceipt]: SesameSendStatus.Viewed,
};

/**
 * Adapted from Signal Desktop's sendStateReducer. A permanent failure is only
 * accepted from Pending. Every authenticated receipt transition is monotonic.
 */
export function sesameSendStateReducer(
  state: SesameSendState,
  action: SesameSendAction,
): SesameSendState {
  const previous = state.status;
  const next = previous === SesameSendStatus.Pending && action.type === SesameSendActionType.Failed
    ? SesameSendStatus.Failed
    : maxSesameSendStatus(previous, ACTION_STATUS[action.type]);

  if (next === previous) return state;
  return { ...state, status: next, updatedAt: action.updatedAt };
}

export type SesameSendStateSummary = Readonly<{
  total: number;
  pending: number;
  failed: number;
  sent: number;
  delivered: number;
  read: number;
  viewed: number;
  skipped: number;
}>;

export function summarizeSesameSendStates(
  sendStateByRecipientId: SesameSendStateByRecipientId,
  ignoredRecipientId?: string,
): SesameSendStateSummary {
  const summary = {
    total: 0,
    pending: 0,
    failed: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    viewed: 0,
    skipped: 0,
  };

  for (const [recipientId, state] of Object.entries(sendStateByRecipientId)) {
    if (ignoredRecipientId && recipientId === ignoredRecipientId) continue;
    summary.total += 1;
    switch (state.status) {
      case SesameSendStatus.Pending:
        summary.pending += 1;
        break;
      case SesameSendStatus.Failed:
        summary.failed += 1;
        break;
      case SesameSendStatus.Sent:
        summary.sent += 1;
        break;
      case SesameSendStatus.Delivered:
        summary.delivered += 1;
        break;
      case SesameSendStatus.Read:
        summary.read += 1;
        break;
      case SesameSendStatus.Viewed:
        summary.viewed += 1;
        break;
      case SesameSendStatus.Skipped:
        summary.skipped += 1;
        break;
    }
  }

  return summary;
}

export function someSesameSendStatus(
  sendStateByRecipientId: SesameSendStateByRecipientId,
  predicate: (status: SesameSendStatus) => boolean,
): boolean {
  return Object.values(sendStateByRecipientId).some(({ status }) => predicate(status));
}

export function someRecipientSesameSendStatus(
  sendStateByRecipientId: SesameSendStateByRecipientId,
  ourRecipientId: string | undefined,
  predicate: (status: SesameSendStatus) => boolean,
): boolean {
  return Object.entries(sendStateByRecipientId).some(([recipientId, { status }]) => (
    recipientId !== ourRecipientId && predicate(status)
  ));
}

export function isSesameMessageJustForMe(
  sendStateByRecipientId: SesameSendStateByRecipientId,
  ourRecipientId: string | undefined,
): boolean {
  if (!ourRecipientId) return false;
  const recipientIds = Object.keys(sendStateByRecipientId);
  return recipientIds.length === 1 && recipientIds[0] === ourRecipientId;
}

export function getHighestSuccessfulRecipientStatus(
  sendStateByRecipientId: SesameSendStateByRecipientId,
  ourRecipientId: string | undefined,
): SesameSendStatus {
  let highest = SesameSendStatus.Pending;
  for (const [recipientId, { status }] of Object.entries(sendStateByRecipientId)) {
    if (recipientId === ourRecipientId || status === SesameSendStatus.Failed) continue;
    highest = maxSesameSendStatus(highest, status);
  }
  return highest;
}

export type SesameUiMessageStatus =
  | OutboundMessageStatus
  | 'pending'
  | 'delivered'
  | 'read'
  | 'viewed'
  | 'blocked'
  | 'partial-sent';

/**
 * Produces one bubble-level status from per-recipient state without hiding a
 * partial group-send failure. The current user's linked-device entry can be
 * excluded through ourRecipientId.
 */
export function aggregateSesameUiMessageStatus(
  sendStateByRecipientId: SesameSendStateByRecipientId,
  ourRecipientId?: string,
): SesameUiMessageStatus {
  const states = Object.entries(sendStateByRecipientId)
    .filter(([recipientId]) => recipientId !== ourRecipientId)
    .map(([, state]) => state.status)
    .filter(status => status !== SesameSendStatus.Skipped);

  if (states.length === 0) return 'pending';

  const hasFailure = states.some(isSesameFailed);
  const hasPending = states.some(isSesamePending);
  const hasSuccess = states.some(isSesameSent);

  if (hasFailure && hasSuccess) return 'partial-sent';
  if (hasFailure && !hasPending && !hasSuccess) return 'failed_visible';
  if (hasPending) return 'pending';

  const highest = states.reduce(maxSesameSendStatus, SesameSendStatus.Pending);
  switch (highest) {
    case SesameSendStatus.Viewed:
      return 'viewed';
    case SesameSendStatus.Read:
      return 'read';
    case SesameSendStatus.Delivered:
      return 'delivered';
    case SesameSendStatus.Sent:
      return 'sent';
    default:
      return 'pending';
  }
}

/** Maps Sesame's detailed queue phases to Signal's stable delivery semantics. */
export function toSesameSendStatus(status: SesameUiMessageStatus | undefined): SesameSendStatus | null {
  switch (status) {
    case 'failed_visible':
    case 'blocked':
    case 'partial-sent':
      return SesameSendStatus.Failed;
    case 'draft':
    case 'pending_local':
    case 'encrypting':
    case 'waiting_secure_channel':
    case 'sending':
    case 'retry_pending':
    case 'pending':
      return SesameSendStatus.Pending;
    case 'sent':
      return SesameSendStatus.Sent;
    case 'delivered':
      return SesameSendStatus.Delivered;
    case 'read':
      return SesameSendStatus.Read;
    case 'viewed':
      return SesameSendStatus.Viewed;
    default:
      return null;
  }
}
