import { Shield, ShieldCheck, Lock, Zap } from 'lucide-react';
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

  return (
    <span className={cn(
      'inline-flex items-center gap-0.5',
      verified ? 'text-emerald-500' : 'text-primary/60',
      className
    )}>
      {verified ? (
        <ShieldCheck className={iconSize} />
      ) : ratchetActive ? (
        <Zap className={iconSize} />
      ) : (
        <Lock className={iconSize} />
      )}
      {showLabel && (
        <span className="text-[9px] font-medium">
          {verified ? 'Vérifié' : ratchetActive ? 'Double Ratchet' : 'Chiffré'}
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
}

export function EncryptionStatusBar({ encrypted, fingerprint, peerFingerprint, ratchetActive }: EncryptionStatusBarProps) {
  if (!encrypted) return null;

  // Determine correct status label
  const hasKeys = !!fingerprint && !!peerFingerprint;
  let statusText: string;
  let StatusIcon = ShieldCheck;

  if (ratchetActive) {
    statusText = 'Canal sécurisé renforcé — forward secrecy par message';
    StatusIcon = Zap;
  } else if (hasKeys) {
    statusText = 'Chiffrement de bout en bout activé';
    StatusIcon = ShieldCheck;
  } else {
    statusText = 'Initialisation sécurisée en cours…';
    StatusIcon = Lock;
  }

  return (
    <div className="flex items-center gap-1.5 px-4 py-1.5 bg-emerald-500/5 border-b border-emerald-500/10">
      <StatusIcon className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
      <span className="text-[10px] text-emerald-700 dark:text-emerald-400 font-medium">
        {statusText}
      </span>
      {hasKeys && (
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
