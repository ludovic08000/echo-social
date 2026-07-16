import { useState } from 'react';
import { ShieldCheck, Lock, Zap, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SafetyNumberDialog } from './SafetyNumberDialog';

const SESAME_SOURCE_URL = 'https://github.com/ludovic08000/echo-social';

interface EncryptionBadgeProps {
  encrypted: boolean;
  verified?: boolean;
  ratchetActive?: boolean;
  size?: 'xs' | 'sm' | 'md';
  showLabel?: boolean;
  className?: string;
}

export function EncryptionBadge({ encrypted, verified, ratchetActive, size = 'xs', showLabel = false, className }: EncryptionBadgeProps) {
  const iconSize = size === 'xs' ? 'w-3 h-3' : size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4';

  if (!encrypted) return null;

  const label = verified
    ? 'Sesame · Vérifié'
    : ratchetActive
      ? 'Sesame · Ratchet'
      : 'Sesame · Chiffré';

  return (
    <span className={cn(
      'inline-flex items-center gap-0.5',
      verified ? 'text-emerald-500' : 'text-muted-foreground',
      className
    )}>
      {verified ? (
        <ShieldCheck className={cn(iconSize, 'text-emerald-500')} aria-hidden="true" />
      ) : ratchetActive ? (
        <Zap className={cn(iconSize, 'text-primary')} aria-hidden="true" />
      ) : (
        <Lock className={iconSize} aria-hidden="true" />
      )}
      {showLabel && (
        <a
          href={SESAME_SOURCE_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          className={cn(
            'text-[9px] font-medium hover:underline underline-offset-2',
            verified ? 'text-emerald-500' : 'text-muted-foreground'
          )}
          title="Sesame est publié sous licence AGPL-3.0 — consulter le code source"
        >
          {label}
        </a>
      )}
    </span>
  );
}

interface EncryptionStatusBarProps {
  encrypted: boolean;
  fingerprint: string | null;
  peerFingerprint: string | null;
  ratchetActive?: boolean;
  fingerprintChanged?: boolean;
  peerName?: string;
  conversationId?: string;
}

export function EncryptionStatusBar({ encrypted, fingerprint, peerFingerprint, ratchetActive, fingerprintChanged = false, peerName = 'Contact', conversationId = '' }: EncryptionStatusBarProps) {
  const [showSafety, setShowSafety] = useState(false);

  if (!encrypted && !fingerprintChanged) return null;

  const hasKeys = !!fingerprint && !!peerFingerprint;

  let statusText: string;
  let StatusIcon = ShieldCheck;

  if (fingerprintChanged) {
    statusText = '⚠️ Sesame : clé de sécurité modifiée — vérification obligatoire';
    StatusIcon = AlertTriangle;
  } else if (ratchetActive) {
    statusText = 'Sesame — X3DH + Double Ratchet, confidentialité persistante par message';
    StatusIcon = Zap;
  } else {
    statusText = 'Sesame — chiffrement de bout en bout activé';
    StatusIcon = ShieldCheck;
  }

  return (
    <>
      <div className={cn(
        'flex items-center gap-1.5 px-4 py-1.5 border-b',
        fingerprintChanged
          ? 'bg-amber-500/10 border-amber-500/20'
          : 'bg-emerald-500/5 border-emerald-500/10'
      )}>
        <StatusIcon className={cn(
          'w-3.5 h-3.5 flex-shrink-0',
          fingerprintChanged ? 'text-amber-600' : 'text-emerald-500'
        )} aria-hidden="true" />
        <span className={cn(
          'text-[10px] font-medium',
          fingerprintChanged ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'
        )}>
          {statusText}
        </span>
        <a
          href={SESAME_SOURCE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-[9px] underline underline-offset-2"
        >
          Code source
        </a>
        {hasKeys && !fingerprintChanged && (
          <button
            type="button"
            onClick={() => setShowSafety(true)}
            className="text-[9px] text-emerald-600 dark:text-emerald-400 underline underline-offset-2"
          >
            Vérifier
          </button>
        )}
      </div>

      {hasKeys && (
        <SafetyNumberDialog
          open={showSafety}
          onOpenChange={setShowSafety}
          myFingerprint={fingerprint!}
          peerFingerprint={peerFingerprint!}
          peerName={peerName}
          conversationId={conversationId}
        />
      )}
    </>
  );
}
