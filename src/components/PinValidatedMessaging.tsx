import { useEffect, useRef, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDeviceLifecycle } from '@/hooks/useDeviceLifecycle';
import { flushCryptoErrors, logCryptoError } from '@/lib/crypto/errorLogger';

interface PinValidatedMessagingProps {
  children: ReactNode;
}

function wakeMessageDecryptors(deviceId: string | null, reason: string): void {
  try {
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', { detail: { reason, deviceId } }));
    window.dispatchEvent(new CustomEvent('forsure:aegis-route-ready', { detail: { reason, deviceId } }));
    window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
      detail: { status: 'pin_unlocked', reason, deviceId },
    }));
  } catch {
    // Best-effort browser notification.
  }
}

/**
 * Invariant cryptographique : dernière garde du flux canonique. La messagerie
 * n'est rendue qu'après binding + clés + `lifecycle_status='ready'` serveur ET
 * synchronisation de compte réellement réussie. Aucune transition n'est
 * déclenchée ici : l'autorité unique reste `deviceLifecycleController`.
 */
export function PinValidatedMessaging({ children }: PinValidatedMessagingProps) {
  const lifecycle = useDeviceLifecycle();
  const wokenFor = useRef<string | null>(null);

  useEffect(() => {
    if (!lifecycle.canRunCryptoRuntime || !lifecycle.deviceId) return;
    if (wokenFor.current === lifecycle.deviceId) return;
    wokenFor.current = lifecycle.deviceId;
    wakeMessageDecryptors(lifecycle.deviceId, 'lifecycle.messaging_ready');
    void flushCryptoErrors().catch(() => undefined);
  }, [lifecycle.canRunCryptoRuntime, lifecycle.deviceId]);

  useEffect(() => {
    if (!lifecycle.error) return;
    logCryptoError({
      severity: 'warning',
      context: 'restore',
      errorCode: 'E2EE_CRYPTO_API_NOT_READY',
      errorMessage: lifecycle.error,
      metadata: { stage: lifecycle.stage, device_id: lifecycle.deviceId },
    });
    void flushCryptoErrors().catch(() => undefined);
  }, [lifecycle.error, lifecycle.stage, lifecycle.deviceId]);

  if (!lifecycle.canRunCryptoRuntime) {
    const syncing = lifecycle.state === 'ACCOUNT_KEY_SYNC';
    return (
      <div className="flex min-h-[40vh] items-center justify-center px-4 py-8">
        <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
          {!lifecycle.error && <Loader2 className="h-6 w-6 animate-spin text-primary" />}
          <p className="text-sm font-medium">
            {syncing ? 'Synchronisation de votre compte…' : 'Finalisation de cet appareil…'}
          </p>
          <p className="text-xs text-muted-foreground">
            {syncing
              ? 'Vérification des clés de compte avant ouverture de la messagerie.'
              : 'Publication des clés de session sécurisée en cours.'}
          </p>
          {lifecycle.error && (
            <div className="w-full space-y-2 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <p>{lifecycle.error}</p>
              <Button size="sm" variant="outline" onClick={lifecycle.retry}>Réessayer</Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
