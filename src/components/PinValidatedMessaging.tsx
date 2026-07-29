import { useEffect, type ReactNode } from 'react';

interface PinValidatedMessagingProps {
  children: ReactNode;
}

function wakeLegacyDecryptors(reason: string): void {
  try {
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
      detail: { reason },
    }));
  } catch {
    // Browser event dispatch is best-effort during teardown/SSR.
  }
}

/**
 * The PIN is a local UI lock only.
 *
 * Opening messaging must never register a device, rotate a Signed PreKey,
 * rebuild routes or refetch the conversation list. Historical Aegis bubbles
 * receive one local wake-up after mount; new server messages need no crypto
 * maintenance at all.
 */
export function PinValidatedMessaging({ children }: PinValidatedMessagingProps) {
  useEffect(() => {
    wakeLegacyDecryptors('pin_gate_opened');
    const frame = window.requestAnimationFrame(() => {
      wakeLegacyDecryptors('pin_gate_bubbles_mounted');
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return <>{children}</>;
}
