// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//
// Adapted for the Aegis web messenger on 2026-07-16 from:
// Signal Desktop — ts/messages/MessageSendState.std.ts
// Signal-specific models and memoization dependencies were removed.

import type { OutboxStatus as OutboundMessageStatus } from './outboxVault';

/**
 * Per-recipient delivery state. The order is monotonic: authenticated receipts
 * may move a message forward, but a late event must never move it backwards.
 */
export enum AegisSendStatus {
  Failed = 'Failed',
  Pending = 'Pending',
  Sent = 'Sent',
  Delivered = 'Delivered',
  Read = 'Read',
  Viewed = 'Viewed',
  Skipped = 'Skipped',
}

export const UNDELIVERED_AEGIS_SEND_STATUSES = [
  AegisSendStatus.Pending,
  AegisSendStatus.Failed,
] as const;

export type AegisVisibleSendStatus = Exclude<AegisSendStatus, AegisSendStatus.Skipped>;

const STATUS_RANK: Record<AegisSendStatus, number> = {
  [AegisSendStatus.Failed]: 0,
  [AegisSendStatus.Pending]: 1,
  [AegisSendStatus.Sent]: 2,
  [AegisSendStatus.Delivered]: 3,
  [AegisSendStatus.Read]: 4,
  [AegisSendStatus.Viewed]: 5,
  [AegisSendStatus.Skipped]: 6,
};

export function maxAegisSendStatus(
  left: AegisSendStatus,
  right: AegisSendStatus,
): AegisSendStatus {
  return STATUS_RANK[left] > STATUS_RANK[right] ? left : right;
}

export function isAegisPending(status: AegisSendStatus): boolean {
  return status === AegisSendStatus.Pending;
}

export function isAegisViewed(status: AegisSendStatus): boolean {
  return status === AegisSendStatus.Viewed;
}

export function isAegisSent(status: AegisSendStatus): boolean {
  return STATUS_RANK[status] >= STATUS_RANK[AegisSendStatus.Sent];
}

export function isAegisDelivered(status: AegisSendStatus): boolean {
  return STATUS_RANK[status] >= STATUS_RANK[AegisSendStatus.Delivered];
}

export function isAegisRead(status: AegisSendStatus): boolean {
  return STATUS_RANK[status] >= STATUS_RANK[AegisSendStatus.Read];
}

export function isAegisFailed(status: AegisSendStatus): boolean {
  return status === AegisSendStatus.Failed;
}

export type AegisSendState = Readonly<{
  status: AegisSendStatus;
  updatedAt?: number;
}>;

export type AegisSendStateByRecipientId = Readonly<Record<string, AegisSendState>>;

export enum AegisSendActionType {
  Failed,
  ManuallyRetried,
  Sent,
  GotDeliveryReceipt,
  GotReadReceipt,
  GotViewedReceipt,
}

export type AegisSendAction = Readonly<{
  type: AegisSendActionType;
  updatedAt: number | undefined;
}>;

const ACTION_STATUS: Record<AegisSendActionType, AegisSendStatus> = {
  [AegisSendActionType.Failed]: AegisSendStatus.Failed,
  [AegisSendActionType.ManuallyRetried]: AegisSendStatus.Pending,
  [AegisSendActionType.Sent]: AegisSendStatus.Sent,
  [AegisSendActionType.GotDeliveryReceipt]: AegisSendStatus.Delivered,
  [AegisSendActionType.GotReadReceipt]: AegisSendStatus.Read,
  [AegisSendActionType.GotViewedReceipt]: AegisSendStatus.Viewed,
};

/**
 * Adapted from Signal Desktop's sendStateReducer. A permanent failure is only
 * accepted from Pending. Every authenticated receipt transition is monotonic.
 */
export function aegisSendStateReducer(
  state: AegisSendState,
  action: AegisSendAction,
): AegisSendState {
  const previous = state.status;
  const next = previous === AegisSendStatus.Pending && action.type === AegisSendActionType.Failed
    ? AegisSendStatus.Failed
    : maxAegisSendStatus(previous, ACTION_STATUS[action.type]);

  if (next === previous) return state;
  return { ...state, status: next, updatedAt: action.updatedAt };
}

export type AegisSendStateSummary = Readonly<{
  total: number;
  pending: number;
  failed: number;
  sent: number;
  delivered: number;
  read: number;
  viewed: number;
  skipped: number;
}>;

export function summarizeAegisSendStates(
  sendStateByRecipientId: AegisSendStateByRecipientId,
  ignoredRecipientId?: string,
): AegisSendStateSummary {
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
      case AegisSendStatus.Pending:
        summary.pending += 1;
        break;
      case AegisSendStatus.Failed:
        summary.failed += 1;
        break;
      case AegisSendStatus.Sent:
        summary.sent += 1;
        break;
      case AegisSendStatus.Delivered:
        summary.delivered += 1;
        break;
      case AegisSendStatus.Read:
        summary.read += 1;
        break;
      case AegisSendStatus.Viewed:
        summary.viewed += 1;
        break;
      case AegisSendStatus.Skipped:
        summary.skipped += 1;
        break;
    }
  }

  return summary;
}

export function someAegisSendStatus(
  sendStateByRecipientId: AegisSendStateByRecipientId,
  predicate: (status: AegisSendStatus) => boolean,
): boolean {
  return Object.values(sendStateByRecipientId).some(({ status }) => predicate(status));
}

export function someRecipientAegisSendStatus(
  sendStateByRecipientId: AegisSendStateByRecipientId,
  ourRecipientId: string | undefined,
  predicate: (status: AegisSendStatus) => boolean,
): boolean {
  return Object.entries(sendStateByRecipientId).some(([recipientId, { status }]) => (
    recipientId !== ourRecipientId && predicate(status)
  ));
}

export function isAegisMessageJustForMe(
  sendStateByRecipientId: AegisSendStateByRecipientId,
  ourRecipientId: string | undefined,
): boolean {
  if (!ourRecipientId) return false;
  const recipientIds = Object.keys(sendStateByRecipientId);
  return recipientIds.length === 1 && recipientIds[0] === ourRecipientId;
}

export function getHighestSuccessfulRecipientStatus(
  sendStateByRecipientId: AegisSendStateByRecipientId,
  ourRecipientId: string | undefined,
): AegisSendStatus {
  let highest = AegisSendStatus.Pending;
  for (const [recipientId, { status }] of Object.entries(sendStateByRecipientId)) {
    if (recipientId === ourRecipientId || status === AegisSendStatus.Failed) continue;
    highest = maxAegisSendStatus(highest, status);
  }
  return highest;
}

export type AegisUiMessageStatus =
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
export function aggregateAegisUiMessageStatus(
  sendStateByRecipientId: AegisSendStateByRecipientId,
  ourRecipientId?: string,
): AegisUiMessageStatus {
  const states = Object.entries(sendStateByRecipientId)
    .filter(([recipientId]) => recipientId !== ourRecipientId)
    .map(([, state]) => state.status)
    .filter(status => status !== AegisSendStatus.Skipped);

  if (states.length === 0) return 'pending';

  const hasFailure = states.some(isAegisFailed);
  const hasPending = states.some(isAegisPending);
  const hasSuccess = states.some(isAegisSent);

  if (hasFailure && hasSuccess) return 'partial-sent';
  if (hasFailure && !hasPending && !hasSuccess) return 'failed_visible';
  if (hasPending) return 'pending';

  const highest = states.reduce(maxAegisSendStatus, AegisSendStatus.Pending);
  switch (highest) {
    case AegisSendStatus.Viewed:
      return 'viewed';
    case AegisSendStatus.Read:
      return 'read';
    case AegisSendStatus.Delivered:
      return 'delivered';
    case AegisSendStatus.Sent:
      return 'sent';
    default:
      return 'pending';
  }
}

/** Maps Aegis's detailed queue phases to Signal's stable delivery semantics. */
export function toAegisSendStatus(status: AegisUiMessageStatus | undefined): AegisSendStatus | null {
  switch (status) {
    case 'failed_visible':
    case 'blocked':
    case 'partial-sent':
      return AegisSendStatus.Failed;
    case 'draft':
    case 'pending_local':
    case 'encrypting':
    case 'waiting_secure_channel':
    case 'sending':
    case 'retry_pending':
    case 'pending':
      return AegisSendStatus.Pending;
    case 'sent':
      return AegisSendStatus.Sent;
    case 'delivered':
      return AegisSendStatus.Delivered;
    case 'read':
      return AegisSendStatus.Read;
    case 'viewed':
      return AegisSendStatus.Viewed;
    default:
      return null;
  }
}
