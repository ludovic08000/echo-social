import type { ReactNode } from 'react';
import { DeviceApprovalGate } from '@/components/messaging/DeviceApprovalGate';
import { MessagingPinGate as LegacyMessagingPinGate } from '@/components/LegacyMessagingPinGate';

interface MessagingPinGateProps {
  children: ReactNode;
  compact?: boolean;
}

/**
 * Invariant de sécurité :
 * session authentifiée -> credential appareil -> approbation explicite -> PIN.
 * Le PIN historique reste inchangé derrière ce gate.
 */
export function MessagingPinGate({ children, compact = false }: MessagingPinGateProps) {
  return (
    <DeviceApprovalGate compact={compact}>
      <LegacyMessagingPinGate compact={compact}>
        {children}
      </LegacyMessagingPinGate>
    </DeviceApprovalGate>
  );
}
