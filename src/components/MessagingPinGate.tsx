import type { ReactNode } from 'react';
import { DeviceApprovalGate } from '@/components/messaging/DeviceApprovalGate';
import { DeviceAccountBindingGate } from '@/components/messaging/DeviceAccountBindingGate';
import { IosMessagingProtectionGate } from '@/components/messaging/IosMessagingProtectionGate';

interface MessagingPinGateProps {
  children: ReactNode;
  compact?: boolean;
}

/**
 * PIN protection is intentionally disabled.
 * Device approval and cryptographic account binding remain mandatory.
 * iOS adds a strict local/server integrity + Passkey-vault gate; outside iOS
 * that gate is a complete no-op, so the validated Windows flow is unchanged.
 */
export function MessagingPinGate({ children, compact = false }: MessagingPinGateProps) {
  return (
    <DeviceApprovalGate compact={compact}>
      <DeviceAccountBindingGate compact={compact}>
        <IosMessagingProtectionGate>
          {children}
        </IosMessagingProtectionGate>
      </DeviceAccountBindingGate>
    </DeviceApprovalGate>
  );
}
