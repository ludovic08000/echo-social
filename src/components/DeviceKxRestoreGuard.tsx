import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import {
  ensureAutoKeyProvisioning,
  resetCurrentDeviceProvisioning,
  resetAutoKeyProvisioningCache,
  type AutoKeyProvisionResult,
} from '@/lib/crypto/autoKeyProvisioning';
import { startRealtimeKeySync, type RealtimeKeySyncHandle } from '@/lib/crypto/realtimeKeySync';
import { logCryptoError } from '@/lib/crypto/errorLogger';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

export function DeviceKxRestoreGuard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const realtimeRef = useRef<RealtimeKeySyncHandle | null>(null);
  const lastStatusRef = useRef<string>('');
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<'restore' | 'reset' | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);

  const showRestoreModalIfNeeded = useCallback((res: AutoKeyProvisionResult | null) => {
    if (!res) return;
    if (res.status === 'restore_required' || res.status === 'blocked' || res.status === 'pin_required') {
      setRestoreMessage(null);
      setRestoreOpen(true);
    }
  }, []);

  const provision = useCallback(async (reason: string, force = false): Promise<AutoKeyProvisionResult | null> => {
    if (!user?.id) return null;
    const res = await ensureAutoKeyProvisioning(user.id, { reason, force });
    const sig = `${res.status}:${res.reason}:${res.deviceId ?? ''}`;
    if (sig !== lastStatusRef.current) {
      lastStatusRef.current = sig;
      logCryptoError({
        severity: res.status === 'ready' ? 'info' : res.status === 'blocked' ? 'critical' : 'warning',
        context: 'restore',
        errorCode: `DEVICE_KX_GUARD_${res.status.toUpperCase()}`,
        errorMessage: res.reason,
        myDeviceId: res.deviceId,
        metadata: { userId: user.id, reason, fingerprint: res.fingerprint },
      });
    }
    return res;
  }, [user?.id]);

  const handleRestore = useCallback(async () => {
    if (!user?.id) return;
    setBusyAction('restore');
    setRestoreMessage(null);
    try {
      resetAutoKeyProvisioningCache(user.id);
      const res = await provision('restore_modal_action', true);
      if (res?.status === 'ready') {
        setRestoreOpen(false);
        return;
      }
      navigate('/settings', { state: { tab: 'privacy', scrollTo: 'key-backup' } });
      setRestoreMessage('Ouvre la restauration de clés depuis les paramètres de confidentialité.');
    } finally {
      setBusyAction(null);
    }
  }, [navigate, provision, user?.id]);

  const handleResetDevice = useCallback(async () => {
    if (!user?.id) return;
    setBusyAction('reset');
    setRestoreMessage(null);
    try {
      const res = await resetCurrentDeviceProvisioning(user.id);
      if (res.status === 'ready') {
        setRestoreOpen(false);
        try {
          window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
            detail: { status: 'device_reset_provisioned', deviceId: res.newDeviceId },
          }));
        } catch {
          /* SSR safe */
        }
        return;
      }
      setRestoreMessage('Réinitialisation créée, mais les clés du compte doivent encore être restaurées.');
    } catch {
      setRestoreMessage('Réinitialisation impossible sans clés restaurées.');
    } finally {
      setBusyAction(null);
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) {
      realtimeRef.current?.stop();
      realtimeRef.current = null;
      lastStatusRef.current = '';
      return;
    }

    let cancelled = false;
    void provision('guard_mount', true).then((res) => {
      showRestoreModalIfNeeded(res);
      if (cancelled || !res || res.status !== 'ready') return;
      try {
        window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
          detail: { status: 'device_kx_guard_ready', deviceId: res.deviceId },
        }));
      } catch {
        /* SSR safe */
      }
    });

    realtimeRef.current?.stop();
    realtimeRef.current = startRealtimeKeySync(user.id, {
      onProvision: (reason) => {
        void provision(reason, false);
      },
    });

    return () => {
      cancelled = true;
      realtimeRef.current?.stop();
      realtimeRef.current = null;
    };
  }, [user?.id, provision, showRestoreModalIfNeeded]);

  useEffect(() => {
    if (!user?.id) return;

    const onKeysRestored = () => {
      resetAutoKeyProvisioningCache(user.id);
      void provision('keys_restored_event', true).then(showRestoreModalIfNeeded);
    };
    const onKeysUnlocked = () => {
      resetAutoKeyProvisioningCache(user.id);
      void provision('keys_unlocked_event', true).then(showRestoreModalIfNeeded);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void provision('visibility_resume').then(showRestoreModalIfNeeded);
    };
    const onRestoreNeeded = () => {
      setRestoreMessage(null);
      setRestoreOpen(true);
    };

    window.addEventListener('forsure-keys-restored', onKeysRestored);
    window.addEventListener('forsure-keys-unlocked', onKeysUnlocked);
    window.addEventListener('forsure:e2ee-restore-needed', onRestoreNeeded);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.removeEventListener('forsure-keys-restored', onKeysRestored);
      window.removeEventListener('forsure-keys-unlocked', onKeysUnlocked);
      window.removeEventListener('forsure:e2ee-restore-needed', onRestoreNeeded);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [user?.id, provision, showRestoreModalIfNeeded]);

  return (
    <AlertDialog open={restoreOpen} onOpenChange={setRestoreOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cet appareil doit restaurer ses clés</AlertDialogTitle>
          <AlertDialogDescription>
            Les clés locales ne correspondent pas à l’état sécurisé du compte. Aucune nouvelle clé d’identité ne sera publiée silencieusement.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {restoreMessage && (
          <p className="text-sm text-muted-foreground">{restoreMessage}</p>
        )}
        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleResetDevice}
            disabled={busyAction !== null}
          >
            {busyAction === 'reset' && <Loader2 className="h-4 w-4 animate-spin" />}
            Réinitialiser cet appareil
          </Button>
          <Button
            type="button"
            onClick={handleRestore}
            disabled={busyAction !== null}
          >
            {busyAction === 'restore' && <Loader2 className="h-4 w-4 animate-spin" />}
            Restaurer mes clés
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
