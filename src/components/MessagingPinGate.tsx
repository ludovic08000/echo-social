import type { ReactNode } from 'react';
import { DeviceApprovalGate } from '@/components/messaging/DeviceApprovalGate';
import { DeviceAccountBindingGate } from '@/components/messaging/DeviceAccountBindingGate';
import { PinUnlockGate } from '@/components/messaging/PinUnlockGate';

interface MessagingPinGateProps {
  children: ReactNode;
  compact?: boolean;
}

/**
 * Strict order:
 * authenticated session -> explicit device approval -> PIN unlock ->
 * account binding -> messaging.
 */
export function MessagingPinGate({ children, compact = false }: MessagingPinGateProps) {
  return (
    <DeviceApprovalGate compact={compact}>
      <PinUnlockGate compact={compact}>
        <DeviceAccountBindingGate compact={compact}>
          {children}
        </DeviceAccountBindingGate>
      </PinUnlockGate>
    </DeviceApprovalGate>
  );
}
