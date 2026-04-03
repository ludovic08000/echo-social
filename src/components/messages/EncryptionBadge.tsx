import { Shield, ShieldCheck, Lock, Zap, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

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
    ? (ratchetActive ? 'X3DH · Vérifié' : 'Chiffré · Vérifié')
    : ratchetActive
      ? 'X3DH · Double Ratchet'
      : 'Chiffré';

  return (
    <span className={cn(
      'inline-flex items-center gap-0.5',
      verified ? 'text-emerald-500' : 'text-muted-foreground',
      className
    )}>
      {verified ? (
        <ShieldCheck className={cn(iconSize, 'text-emerald-500')} />
      ) : ratchetActive ? (
        <Zap className={cn(iconSize, 'text-primary')} />
      ) : (
        <Lock className={iconSize} />
      )}
      {showLabel && (
        <span className={cn(
          'text-[9px] font-medium',
          verified ? 'text-emerald-500' : 'text-muted-foreground'
        )}>
          {label}
        </span>
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
}

export function EncryptionStatusBar({ encrypted, fingerprint, peerFingerprint, ratchetActive, fingerprintChanged = false }: EncryptionStatusBarProps) {
  if (!encrypted && !fingerprintChanged) return null;

  const hasKeys = !!fingerprint && !!peerFingerprint;

  // Determine status — never show "initialisation" loading state, just show encrypted
  let statusText: string;
  let StatusIcon = ShieldCheck;

  if (fingerprintChanged) {
    statusText = '⚠️ Clé de sécurité modifiée — vérification obligatoire avant envoi';
    StatusIcon = AlertTriangle;
  } else if (ratchetActive) {
    statusText = 'Canal sécurisé renforcé — forward secrecy par message';
    StatusIcon = Zap;
  } else {
    statusText = 'Chiffrement de bout en bout activé';
    StatusIcon = ShieldCheck;
  }

  return (
    <div className={cn(
      'flex items-center gap-1.5 px-4 py-1.5 border-b',
      fingerprintChanged
        ? 'bg-amber-500/10 border-amber-500/20'
        : 'bg-emerald-500/5 border-emerald-500/10'
    )}>
      <StatusIcon className={cn(
        'w-3.5 h-3.5 flex-shrink-0',
        fingerprintChanged ? 'text-amber-600' : 'text-emerald-500'
      )} />
      <span className={cn(
        'text-[10px] font-medium',
        fingerprintChanged ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'
      )}>
        {statusText}
      </span>
      {hasKeys && !fingerprintChanged && (
        <button
          onClick={() => {
            const msg = `🔐 Numéros de sécurité\n\nVotre clé:\n${fingerprint}\n\nClé du contact:\n${peerFingerprint}\n\nComparez ces numéros en personne pour vérifier l'identité.`;
            alert(msg);
          }}
          className="ml-auto text-[9px] text-emerald-600 dark:text-emerald-400 underline underline-offset-2"
        >
          Vérifier
        </button>
      )}
    </div>
  );
}
