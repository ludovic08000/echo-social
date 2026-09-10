import type { ReactNode } from 'react';
import { DeviceApprovalGate } from '@/components/messaging/DeviceApprovalGate';
import { DeviceAccountBindingGate } from '@/components/messaging/DeviceAccountBindingGate';

interface MessagingPinGateProps {
  children: ReactNode;
  compact?: boolean;
}

/**
 * PIN protection is intentionally disabled.
 * Device approval and cryptographic account binding remain mandatory.
 */
export function MessagingPinGate({ children, compact = false }: MessagingPinGateProps) {
  return (
    <DeviceApprovalGate compact={compact}>
      <DeviceAccountBindingGate compact={compact}>
        {children}
      </DeviceAccountBindingGate>
    </DeviceApprovalGate>
  );
}
