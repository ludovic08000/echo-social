import { useEffect } from 'react';
import { toast } from 'sonner';

export function DeviceKxRestoreGuard() {
  useEffect(() => {
    const onRestoreRequired = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      console.warn('[DeviceKxRestoreGuard] device key restore required', detail);
      toast.error('Messagerie sécurisée verrouillée : entrez votre PIN pour restaurer les clés.', { duration: 8000 });
      try {
        window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', {
          detail: { ...detail, source: 'device-kx-restore-guard' },
        }));
      } catch {}
    };

    window.addEventListener('forsure:device-kx-restore-required', onRestoreRequired);
    return () => window.removeEventListener('forsure:device-kx-restore-required', onRestoreRequired);
  }, []);

  return null;
}
