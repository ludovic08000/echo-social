import { Shield, ShieldCheck, ShieldAlert, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EncryptionBadgeProps {
  encrypted: boolean;
  verified?: boolean;
  size?: 'xs' | 'sm' | 'md';
  showLabel?: boolean;
  className?: string;
}

export function EncryptionBadge({ encrypted, verified, size = 'xs', showLabel = false, className }: EncryptionBadgeProps) {
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
      ) : (
        <Lock className={iconSize} />
      )}
      {showLabel && (
        <span className="text-[9px] font-medium">
          {verified ? 'Vérifié' : 'Chiffré'}
        </span>
      )}
    </span>
  );
}

interface EncryptionStatusBarProps {
  encrypted: boolean;
  fingerprint: string | null;
  peerFingerprint: string | null;
}

export function EncryptionStatusBar({ encrypted, fingerprint, peerFingerprint }: EncryptionStatusBarProps) {
  if (!encrypted) return null;

  return (
    <div className="flex items-center gap-1.5 px-4 py-1.5 bg-emerald-500/5 border-b border-emerald-500/10">
      <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
      <span className="text-[10px] text-emerald-700 dark:text-emerald-400 font-medium">
        Chiffrement de bout en bout activé
      </span>
      {fingerprint && peerFingerprint && (
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
