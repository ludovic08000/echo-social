// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//
// Adapted for the Sesame web messenger on 2026-07-16 from:
// Signal Desktop — ts/messages/MessageSendState.std.ts
// The original Signal-specific model and memoization dependencies were removed.

import type { OutboundMessageStatus } from './messageQueue';

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

export function isSesameSent(status: SesameSendStatus): boolean {
  return STATUS_RANK[status] >= STATUS_RANK[SesameSendStatus.Sent];
}

export function isSesameDelivered(status: SesameSendStatus): boolean {
  return STATUS_RANK[status] >= STATUS_RANK[SesameSendStatus.Delivered];
}

export function isSesameRead(status: SesameSendStatus): boolean {
  return STATUS_RANK[status] >= STATUS_RANK[SesameSendStatus.Read];
}

export type SesameSendState = Readonly<{
  status: SesameSendStatus;
  updatedAt?: number;
}>;

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
 * accepted from Pending. Every receipt transition is monotonic.
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

export type SesameUiMessageStatus =
  | OutboundMessageStatus
  | 'pending'
  | 'delivered'
  | 'read'
  | 'viewed'
  | 'blocked'
  | 'partial-sent';

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
