// Copyright 2018 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// Modified by the Sesame project on 2026-07-16.

import type { ReactNode } from 'react';
import {
  Check,
  CheckCheck,
  Clock3,
  Eye,
  Loader2,
  LockKeyhole,
  Pencil,
  Pin,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { OutboxStatus as OutboundMessageStatus } from '@/lib/messaging/outboxVault';
import {
  aggregateSesameUiMessageStatus,
  SesameSendStatus,
  summarizeSesameSendStates,
  toSesameSendStatus,
  type SesameSendStateByRecipientId,
  type SesameUiMessageStatus,
} from '@/lib/messaging/sesameSendState';
import { SesameDeliveryIssueNotice } from './SesameDeliveryIssueNotice';

export type SesameMessageStatus = SesameUiMessageStatus;

export interface SesameMessageMetadataProps {
  direction: 'incoming' | 'outgoing';
  status?: SesameMessageStatus;
  sendStateByRecipientId?: SesameSendStateByRecipientId;
  ourRecipientId?: string;
  timestamp?: string | number | Date;
  encrypted?: boolean;
  verified?: boolean;
  edited?: boolean;
  pinned?: boolean;
  compact?: boolean;
  lastError?: string | null;
  onRetry?: () => void;
  onRemove?: () => void;
  onVerifyIdentity?: () => void;
  className?: string;
}

type StatusPresentation = {
  label: string;
  icon: ReactNode;
};

function pendingPresentation(
  status: OutboundMessageStatus | 'pending' | undefined,
  compact: boolean,
): StatusPresentation {
  const iconClass = compact ? 'h-2.5 w-2.5' : 'h-3 w-3';

  switch (status) {
    case 'draft':
    case 'pending_local':
      return { label: 'En attente', icon: <Clock3 className={iconClass} aria-hidden="true" /> };
    case 'encrypting':
      return {
        label: 'Chiffrement…',
        icon: <LockKeyhole className={cn(iconClass, 'animate-pulse')} aria-hidden="true" />,
      };
    case 'waiting_secure_channel':
      return {
        label: 'Canal sécurisé…',
        icon: <LockKeyhole className={iconClass} aria-hidden="true" />,
      };
    case 'retry_pending':
      return {
        label: 'Nouvelle tentative…',
        icon: <Loader2 className={cn(iconClass, 'animate-spin')} aria-hidden="true" />,
      };
    default:
      return {
        label: 'Envoi…',
        icon: <Loader2 className={cn(iconClass, 'animate-spin')} aria-hidden="true" />,
      };
  }
}

function statusPresentation(
  status: SesameMessageStatus | undefined,
  compact: boolean,
): StatusPresentation | null {
  const semantic = toSesameSendStatus(status);
  const iconClass = compact ? 'h-2.5 w-2.5' : 'h-3 w-3';

  switch (semantic) {
    case SesameSendStatus.Pending:
      return pendingPresentation(status as OutboundMessageStatus | 'pending' | undefined, compact);
    case SesameSendStatus.Sent:
      return { label: 'Envoyé', icon: <Check className={iconClass} aria-hidden="true" /> };
    case SesameSendStatus.Delivered:
      return { label: 'Délivré', icon: <CheckCheck className={iconClass} aria-hidden="true" /> };
    case SesameSendStatus.Read:
      return { label: 'Lu', icon: <CheckCheck className={iconClass} aria-hidden="true" /> };
    case SesameSendStatus.Viewed:
      return { label: 'Vu', icon: <Eye className={iconClass} aria-hidden="true" /> };
    default:
      return null;
  }
}

function normalizeTimestamp(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTimestamp(value: string | number | Date): string {
  const date = normalizeTimestamp(value);
  if (!date) return '';
  return new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function buildRecipientSummary(
  sendStateByRecipientId: SesameSendStateByRecipientId | undefined,
  ourRecipientId: string | undefined,
): string | undefined {
  if (!sendStateByRecipientId) return undefined;
  const summary = summarizeSesameSendStates(sendStateByRecipientId, ourRecipientId);
  if (summary.total === 0) return undefined;

  const successful = summary.sent + summary.delivered + summary.read + summary.viewed;
  const parts = [`${successful}/${summary.total} envoyé${summary.total > 1 ? 's' : ''}`];
  if (summary.delivered) parts.push(`${summary.delivered} délivré${summary.delivered > 1 ? 's' : ''}`);
  if (summary.read) parts.push(`${summary.read} lu${summary.read > 1 ? 's' : ''}`);
  if (summary.viewed) parts.push(`${summary.viewed} vu${summary.viewed > 1 ? 's' : ''}`);
  if (summary.failed) parts.push(`${summary.failed} en échec`);
  if (summary.pending) parts.push(`${summary.pending} en attente`);
  return parts.join(' · ');
}

/**
 * Adapted from Signal Desktop's MessageMetadata.dom.tsx.
 *
 * Message content and delivery metadata remain separate. A transport failure
 * changes only this metadata row; it never replaces authenticated plaintext.
 * Group messages can now derive one bubble-level state from monotonic
 * per-recipient send states.
 */
export function SesameMessageMetadata({
  direction,
  status,
  sendStateByRecipientId,
  ourRecipientId,
  timestamp,
  encrypted = false,
  verified = false,
  edited = false,
  pinned = false,
  compact = false,
  lastError,
  onRetry,
  onRemove,
  onVerifyIdentity,
  className,
}: SesameMessageMetadataProps) {
  const outgoing = direction === 'outgoing';
  const aggregateStatus = outgoing && sendStateByRecipientId
    ? aggregateSesameUiMessageStatus(sendStateByRecipientId, ourRecipientId)
    : undefined;
  const effectiveStatus = status ?? aggregateStatus;
  const semanticStatus = toSesameSendStatus(effectiveStatus);
  const isFailure = outgoing && semanticStatus === SesameSendStatus.Failed;
  const recipientSummary = buildRecipientSummary(sendStateByRecipientId, ourRecipientId);

  if (isFailure) {
    return (
      <SesameDeliveryIssueNotice
        label={effectiveStatus === 'partial-sent' ? 'Envoi partiel' : undefined}
        detail={lastError}
        failure={lastError}
        onRetry={onRetry}
        onRemove={onRemove}
        onVerifyIdentity={onVerifyIdentity}
        compact={compact}
        className={className}
      />
    );
  }

  const presentation = outgoing ? statusPresentation(effectiveStatus, compact) : null;
  const timestampDate = timestamp !== undefined ? normalizeTimestamp(timestamp) : null;
  const timeLabel = timestampDate ? formatTimestamp(timestampDate) : '';
  const textClass = compact ? 'text-[8px]' : 'text-[10px]';
  const iconClass = compact ? 'h-2.5 w-2.5' : 'h-3 w-3';

  return (
    <div
      className={cn(
        'inline-flex flex-wrap items-center gap-1 text-muted-foreground',
        textClass,
        className,
      )}
      data-send-status={semanticStatus ?? undefined}
      aria-label={recipientSummary}
      title={recipientSummary}
      aria-live="off"
    >
      {pinned && <Pin className={iconClass} aria-label="Épinglé" />}
      {edited && (
        <span className="inline-flex items-center gap-0.5">
          <Pencil className={iconClass} aria-hidden="true" />
          modifié
        </span>
      )}
      {timeLabel && timestampDate && (
        <time dateTime={timestampDate.toISOString()}>{timeLabel}</time>
      )}
      {encrypted && (
        <LockKeyhole
          className={cn(iconClass, verified ? 'opacity-90' : 'opacity-55')}
          aria-label={verified ? 'Message chiffré et vérifié' : 'Message chiffré'}
        />
      )}
      {presentation && (
        <span
          className={cn(
            'inline-flex items-center gap-0.5',
            (semanticStatus === SesameSendStatus.Read || semanticStatus === SesameSendStatus.Viewed) && 'text-primary',
          )}
          title={recipientSummary || presentation.label}
        >
          {presentation.icon}
          <span>{presentation.label}</span>
        </span>
      )}
    </div>
  );
}
