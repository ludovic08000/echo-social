import type { ReactNode } from 'react';
import { DeviceApprovalGate } from '@/components/messaging/DeviceApprovalGate';
import { PinUnlockGate } from '@/components/messaging/PinUnlockGate';

interface MessagingPinGateProps {
  children: ReactNode;
  compact?: boolean;
}

/**
 * Invariant cryptographique : ordre canonique unique et obligatoire. Pour un
 * appareil secondaire, DeviceApprovalGate peut exposer PinUnlockGate avant la
 * décision finale uniquement si la clé de compte verrouillée est nécessaire
 * pour signer cette décision. Cela n'ouvre ni le binding ni la messagerie.
 * Après approbation : PIN -> binding -> clés SPK/OPK/libsignal ->
 * synchronisation de compte confirmée -> messagerie.
 */
export function MessagingPinGate({ children, compact = false }: MessagingPinGateProps) {
  return (
    <DeviceApprovalGate compact={compact}>
      <PinUnlockGate compact={compact}>
        {children}
      </PinUnlockGate>
    </DeviceApprovalGate>
  );
}
