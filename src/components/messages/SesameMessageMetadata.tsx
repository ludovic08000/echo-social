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
import type { OutboundMessageStatus } from '@/lib/messaging/messageQueue';
import { SesameDeliveryIssueNotice } from './SesameDeliveryIssueNotice';

export type SesameMessageStatus =
  | OutboundMessageStatus
  | 'pending'
  | 'delivered'
  | 'read'
  | 'viewed'
  | 'blocked'
  | 'partial-sent';

export interface SesameMessageMetadataProps {
  direction: 'incoming' | 'outgoing';
  status?: SesameMessageStatus;
  timestamp?: string | number | Date;
  encrypted?: boolean;
  verified?: boolean;
  edited?: boolean;
  pinned?: boolean;
  compact?: boolean;
  lastError?: string | null;
  onRetry?: () => void;
  onRemove?: () => void;
  className?: string;
}

type StatusPresentation = {
  label: string;
  icon: ReactNode;
};

function statusPresentation(status: SesameMessageStatus | undefined, compact: boolean): StatusPresentation | null {
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
    case 'sending':
    case 'pending':
      return {
        label: 'Envoi…',
        icon: <Loader2 className={cn(iconClass, 'animate-spin')} aria-hidden="true" />,
      };
    case 'retry_pending':
      return {
        label: 'Nouvelle tentative…',
        icon: <Loader2 className={cn(iconClass, 'animate-spin')} aria-hidden="true" />,
      };
    case 'sent':
      return { label: 'Envoyé', icon: <Check className={iconClass} aria-hidden="true" /> };
    case 'delivered':
      return { label: 'Délivré', icon: <CheckCheck className={iconClass} aria-hidden="true" /> };
    case 'read':
      return { label: 'Lu', icon: <CheckCheck className={iconClass} aria-hidden="true" /> };
    case 'viewed':
      return { label: 'Vu', icon: <Eye className={iconClass} aria-hidden="true" /> };
    default:
      return null;
  }
}

function formatTimestamp(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * Adapted from Signal Desktop's MessageMetadata.dom.tsx.
 *
 * Message content and delivery metadata remain separate. A transport failure
 * changes only this metadata row; it never replaces authenticated plaintext.
 */
export function SesameMessageMetadata({
  direction,
  status,
  timestamp,
  encrypted = false,
  verified = false,
  edited = false,
  pinned = false,
  compact = false,
  lastError,
  onRetry,
  onRemove,
  className,
}: SesameMessageMetadataProps) {
  const outgoing = direction === 'outgoing';
  const isFailure = outgoing && (
    status === 'failed_visible' ||
    status === 'blocked' ||
    status === 'partial-sent'
  );

  if (isFailure) {
    return (
      <SesameDeliveryIssueNotice
        label={status === 'partial-sent' ? 'Envoi partiel' : "Échec d'envoi"}
        detail={lastError}
        onRetry={onRetry}
        onRemove={onRemove}
        compact={compact}
        className={className}
      />
    );
  }

  const presentation = outgoing ? statusPresentation(status, compact) : null;
  const timeLabel = timestamp !== undefined ? formatTimestamp(timestamp) : '';
  const textClass = compact ? 'text-[8px]' : 'text-[10px]';
  const iconClass = compact ? 'h-2.5 w-2.5' : 'h-3 w-3';

  return (
    <div
      className={cn(
        'inline-flex flex-wrap items-center gap-1 text-muted-foreground',
        textClass,
        className,
      )}
      aria-live="off"
    >
      {pinned && <Pin className={iconClass} aria-label="Épinglé" />}
      {edited && (
        <span className="inline-flex items-center gap-0.5">
          <Pencil className={iconClass} aria-hidden="true" />
          modifié
        </span>
      )}
      {timeLabel && <time dateTime={new Date(timestamp!).toISOString()}>{timeLabel}</time>}
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
            (status === 'read' || status === 'viewed') && 'text-primary',
          )}
          title={presentation.label}
        >
          {presentation.icon}
          <span>{presentation.label}</span>
        </span>
      )}
    </div>
  );
}
