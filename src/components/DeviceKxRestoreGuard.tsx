import { useEffect } from 'react';
import { toast } from 'sonner';

/**
 * DeviceKxRestoreGuard
 *
 * Listens for the strict device-key stability guard.
 *
 * When IndexedDB/iOS loses the local device private key while the server still
 * knows this device_id + device_public_key, we MUST NOT regenerate silently.
 * Instead, we show a recovery prompt and notify the existing PIN/restore flow.
 */
export function DeviceKxRestoreGuard() {
  useEffect(() => {
    const onRestoreRequired = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      console.warn('[DeviceKxRestoreGuard] device key restore required', detail);

      toast.error(
        'Sécurité messagerie : cet appareil doit être restauré avec votre PIN avant de continuer.',
        { duration: 9000 },
      );

      try {
        window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', {
          detail: {
            ...detail,
            source: 'device-kx-restore-guard',
            reason: detail.reason || 'device_key_restore_required',
          },
        }));
      } catch {
        // non-fatal
      }
    };

    window.addEventListener('forsure:device-kx-restore-required', onRestoreRequired);
    return () => window.removeEventListener('forsure:device-kx-restore-required', onRestoreRequired);
  }, []);

  return null;
}
