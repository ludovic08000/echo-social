import type { ReactNode } from 'react';
import { DeviceApprovalGate } from '@/components/messaging/DeviceApprovalGate';
import { DeviceAccountBindingGate } from '@/components/messaging/DeviceAccountBindingGate';
import { MessagingPinGate as LegacyMessagingPinGate } from '@/components/LegacyMessagingPinGate';

interface MessagingPinGateProps {
  children: ReactNode;
  compact?: boolean;
}

/**
 * Strict order:
 * authenticated session -> device credential -> explicit approval -> PIN ->
 * account binding -> messaging.
 */
export function MessagingPinGate({ children, compact = false }: MessagingPinGateProps) {
  return (
    <DeviceApprovalGate compact={compact}>
      <LegacyMessagingPinGate compact={compact}>
        <DeviceAccountBindingGate compact={compact}>
          {children}
        </DeviceAccountBindingGate>
      </LegacyMessagingPinGate>
    </DeviceApprovalGate>
  );
}
