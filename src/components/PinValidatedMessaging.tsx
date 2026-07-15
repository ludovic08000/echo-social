import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { repairApprovedDeviceTrust } from '@/lib/crypto/deviceLinkTrust';
import { publishOwnSignedDeviceList } from '@/lib/crypto/signedDeviceList';
import {
  getCurrentDeviceId,
  hydrateDeviceId,
  inspectDeviceHealth,
  isDeviceIdTemporary,
  recoverStableDeviceLifecycle,
  requireAuthenticatedDeviceSession,
  resyncE2EE,
  runDeviceOperation,
} from '@/lib/device-manager';

interface PinValidatedMessagingProps {
  children: ReactNode;
}

type ValidationState =
  | { status: 'checking' }
  | { status: 'ready'; trustedCount: number; degraded: boolean }
  | {
      status: 'failed';
      reason: string;
      currentDeviceId: string;
      trustedCount: number;
      totalCount: number;
      rejections: Record<string, number>;
    };

function reasonForLocalHealth(report: Awaited<ReturnType<typeof inspectDeviceHealth>>): string {
  if (report.lifecycle !== 'approved') {
    return `Cycle de vie de l’appareil : ${report.lifecycle}.`;
  }
  if (!report.hasSignedPrekey) {
    return 'La préclé signée de ce nouvel appareil est absente ou expirée.';
  }
  return 'Les clés locales ne sont pas encore prêtes.';
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('DEVICE_REVOKED_PIN_UNLOCK_REQUIRED')) {
    return 'Cet appareil a été révoqué. Ressaisissez le PIN pour le réinscrire comme nouvel appareil.';
  }
  if (message.includes('DEVICE_REVOKED_REENROLLMENT_BLOCKED')) {
    return 'La création du nouvel identifiant d’appareil a été bloquée.';
  }
  if (message.includes('DEVICE_REAPPROVAL_FAILED:pending')) {
    return 'Le nouvel appareil est enregistré mais son approbation a été refusée.';
  }
  if (message.includes('DEVICE_REGISTRATION')) {
    return 'L’enregistrement du nouvel appareil a échoué.';
  }
  return message;
}

function dispatchMessagingRecovery(deviceId: string): void {
  try {
    window.dispatchEvent(new CustomEvent('forsure:e2ee-request-refanout-scan', {
      detail: { reason: 'pin_local_device_ready', deviceId },
    }));
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
      detail: { reason: 'pin_local_device_ready' },
    }));
  } catch {}
}

/**
 * PIN boundary for the local installation.
 *
 * A revoked DeviceID is never reactivated. Possession of the PIN-restored
 * account identity authorizes a one-time reenrollment with a fresh DeviceID,
 * fresh X25519 transport key and fresh SPK/OPKs. Old companions are repaired in
 * the background and never block opening the local inbox.
 */
export function PinValidatedMessaging({ children }: PinValidatedMessagingProps) {
  const { user } = useAuth();
  const [runId, setRunId] = useState(0);
  const [state, setState] = useState<ValidationState>({ status: 'checking' });

  const validate = useCallback(async () => {
    if (!user?.id) {
      setState({
        status: 'failed',
        reason: 'Session utilisateur absente.',
        currentDeviceId: '',
        trustedCount: 0,
        totalCount: 0,
        rejections: {},
      });
      return;
    }

    setState({ status: 'checking' });
    let currentDeviceId = '';

    try {
      const local = await runDeviceOperation(`pin-local-ready:${user.id}`, async () => {
        await requireAuthenticatedDeviceSession(user.id);
        await hydrateDeviceId();

        const initialDeviceId = getCurrentDeviceId();
        currentDeviceId = initialDeviceId;
        if (!initialDeviceId || isDeviceIdTemporary()) {
          throw new Error('Identifiant d’appareil encore temporaire.');
        }

        const lifecycle = await recoverStableDeviceLifecycle(user.id, initialDeviceId);
        const activeDeviceId = lifecycle.deviceId;
        currentDeviceId = activeDeviceId;

        let health = await inspectDeviceHealth(user.id, activeDeviceId);
        if (!health.hasSignedPrekey) {
          // One bounded provisioning pass for the active replacement device.
          await resyncE2EE(user.id);
          const resyncedDeviceId = getCurrentDeviceId();
          currentDeviceId = resyncedDeviceId;
          health = await inspectDeviceHealth(user.id, resyncedDeviceId);
        }

        return {
          deviceId: currentDeviceId,
          previousDeviceId: lifecycle.replacedDeviceId,
          health,
        };
      }, { coalesce: true });

      currentDeviceId = local.deviceId;
      const localReady = local.health.lifecycle === 'approved' && local.health.hasSignedPrekey;

      console.info('[PIN-DEVTRUST] local device gate', {
        userId: user.id.slice(0, 8),
        previousDeviceId: local.previousDeviceId?.slice(0, 8) ?? null,
        currentDeviceId: currentDeviceId.slice(0, 8),
        reenrolled: Boolean(local.previousDeviceId),
        lifecycle: local.health.lifecycle,
        hasSignedPrekey: local.health.hasSignedPrekey,
        currentTrusted: local.health.trusted,
        trusted: local.health.trustedCount,
        total: local.health.totalCount,
        degraded: !local.health.trusted,
        reasons: local.health.rejectionReasons,
      });

      if (!localReady) {
        setState({
          status: 'failed',
          reason: reasonForLocalHealth(local.health),
          currentDeviceId,
          trustedCount: local.health.trustedCount,
          totalCount: local.health.totalCount,
          rejections: local.health.rejectionReasons,
        });
        return;
      }

      setState({
        status: 'ready',
        trustedCount: local.health.trustedCount,
        degraded: !local.health.trusted,
      });
      dispatchMessagingRecovery(currentDeviceId);

      void runDeviceOperation(`pin-background-repair:${user.id}`, async () => {
        try {
          const repaired = await repairApprovedDeviceTrust(user.id);
          const published = await publishOwnSignedDeviceList();
          const activeDeviceId = getCurrentDeviceId();
          const health = await inspectDeviceHealth(user.id, activeDeviceId);
          console.info('[PIN-DEVTRUST] background companion repair', {
            userId: user.id.slice(0, 8),
            currentDeviceId: activeDeviceId.slice(0, 8),
            repaired,
            published: published.ok,
            lifecycle: health.lifecycle,
            hasSignedPrekey: health.hasSignedPrekey,
            currentTrusted: health.trusted,
            trusted: health.trustedCount,
            total: health.totalCount,
            reasons: health.rejectionReasons,
          });
          dispatchMessagingRecovery(activeDeviceId);
        } catch (error) {
          console.warn('[PIN-DEVTRUST] background repair deferred', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }, { coalesce: true }).catch(() => {});
    } catch (error) {
      setState({
        status: 'failed',
        reason: friendlyError(error),
        currentDeviceId: currentDeviceId || getCurrentDeviceId(),
        trustedCount: 0,
        totalCount: 0,
        rejections: {},
      });
    }
  }, [user?.id, runId]);

  useEffect(() => {
    void validate();
  }, [validate]);

  if (state.status === 'ready') return <>{children}</>;

  if (state.status === 'checking') {
    return (
      <div className="flex h-full min-h-[40vh] items-center justify-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
            <ShieldCheck className="h-7 w-7 text-primary" />
            <div className="absolute inset-0 animate-spin rounded-2xl border-2 border-primary border-t-transparent" />
          </div>
          <div>
            <p className="font-semibold">Ouverture de la messagerie…</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Vérification ou réinscription sécurisée de cet appareil.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const rejectionText = Object.entries(state.rejections)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(' · ');

  return (
    <div className="flex h-full min-h-[40vh] items-center justify-center p-5">
      <div className="w-full max-w-md rounded-2xl border border-destructive/20 bg-card p-5 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10">
          <AlertTriangle className="h-6 w-6 text-destructive" />
        </div>
        <h2 className="mt-3 font-semibold">Appareil local indisponible</h2>
        <p className="mt-2 text-sm text-muted-foreground">{state.reason}</p>
        <div className="mt-3 rounded-xl bg-muted/50 p-3 text-left text-xs text-muted-foreground">
          <p><strong>Appareil :</strong> {state.currentDeviceId ? state.currentDeviceId.slice(0, 12) : 'indisponible'}</p>
          <p><strong>Appareils fiables :</strong> {state.trustedCount}/{state.totalCount}</p>
          {rejectionText && <p className="mt-1"><strong>Diagnostic secondaire :</strong> {rejectionText}</p>}
        </div>
        <p className="mt-3 flex items-center justify-center gap-1 text-xs text-muted-foreground">
          <KeyRound className="h-3.5 w-3.5" />
          Un appareil révoqué est recréé avec un nouvel identifiant après le PIN.
        </p>
        <Button className="mt-4 gap-2" onClick={() => setRunId((value) => value + 1)}>
          <RefreshCw className="h-4 w-4" />
          Réinscrire cet appareil
        </Button>
      </div>
    </div>
  );
}
