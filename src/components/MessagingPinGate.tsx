import type { ReactNode } from 'react';
import { DeviceApprovalGate } from '@/components/messaging/DeviceApprovalGate';
import { PinUnlockGate } from '@/components/messaging/PinUnlockGate';

interface MessagingPinGateProps {
  children: ReactNode;
  compact?: boolean;
}

/**
 * Invariant cryptographique : ordre canonique unique et obligatoire.
 * authentification -> DeviceID serveur -> enrôlement/approbation serveur
 * -> déverrouillage PIN -> binding -> clés SPK/OPK/libsignal
 * -> synchronisation de compte confirmée -> messagerie.
 * Aucun chemin PIN-first, aucun contournement du PIN.
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
