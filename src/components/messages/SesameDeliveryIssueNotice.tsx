// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// Modified by the Sesame project on 2026-07-16.

import { AlertTriangle, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  classifySesameDeliveryFailure,
  shouldOfferSesameRetry,
  type SesameDeliveryFailure,
} from '@/lib/messaging/sesameDeliveryPolicy';

export interface SesameDeliveryIssueNoticeProps {
  label?: string;
  detail?: string | null;
  failure?: unknown;
  onRetry?: () => void;
  onRemove?: () => void;
  onVerifyIdentity?: () => void;
  compact?: boolean;
  className?: string;
}

/**
 * Adapted from Signal Desktop's DeliveryIssueNotification.dom.tsx.
 *
 * The failed delivery is represented as metadata attached to the existing
 * message bubble. The authenticated message content is never replaced by an
 * error placeholder. Raw transport errors are classified into stable,
 * user-safe recovery instructions before being displayed.
 */
export function SesameDeliveryIssueNotice({
  label,
  detail,
  failure,
  onRetry,
  onRemove,
  onVerifyIdentity,
  compact = false,
  className,
}: SesameDeliveryIssueNoticeProps) {
  const classified: SesameDeliveryFailure = classifySesameDeliveryFailure(failure ?? detail ?? label);
  const displayLabel = label || classified.title;
  const canRetry = Boolean(onRetry && shouldOfferSesameRetry(classified));
  const canVerify = Boolean(onVerifyIdentity && classified.kind === 'identity-changed');

  return (
    <div
      className={cn(
        'inline-flex flex-wrap items-center gap-1.5 text-destructive',
        compact ? 'text-[9px]' : 'text-[10px]',
        className,
      )}
      role="status"
      aria-live="polite"
      title={classified.userMessage}
      data-delivery-failure={classified.kind}
      data-retry-mode={classified.retryMode}
    >
      <AlertTriangle className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} aria-hidden="true" />
      <span className="font-medium">{displayLabel}</span>

      {canVerify && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onVerifyIdentity?.();
          }}
          className="inline-flex items-center gap-0.5 font-semibold underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current"
        >
          <ShieldCheck className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} aria-hidden="true" />
          Vérifier
        </button>
      )}

      {canRetry && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRetry?.();
          }}
          className="inline-flex items-center gap-0.5 font-semibold underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current"
        >
          <RotateCcw className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} aria-hidden="true" />
          Réessayer
        </button>
      )}

      {onRemove && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="inline-flex items-center gap-0.5 font-semibold text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current"
        >
          <Trash2 className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} aria-hidden="true" />
          Supprimer
        </button>
      )}
    </div>
  );
}
