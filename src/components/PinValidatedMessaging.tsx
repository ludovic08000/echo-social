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
  | { status: 'ready'; trustedCount: number }
  | {
      status: 'failed';
      reason: string;
      currentDeviceId: string;
      trustedCount: number;
      totalCount: number;
      rejections: Record<string, number>;
    };

function reasonForHealth(report: Awaited<ReturnType<typeof inspectDeviceHealth>>): string {
  if (report.lifecycle !== 'approved') {
    return `Cycle de vie de l’appareil : ${report.lifecycle}.`;
  }
  if (!report.trusted) {
    return 'L’appareil courant n’est pas signé par la clé restaurée avec le PIN.';
  }
  if (!report.hasSignedPrekey) {
    return 'La préclé signée de cet appareil est absente ou expirée.';
  }
  return 'Appareil non validé après restauration du PIN.';
}

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
      const result = await runDeviceOperation(`pin-validation:${user.id}`, async () => {
        await requireAuthenticatedDeviceSession(user.id);
        await hydrateDeviceId();
        const deviceId = getCurrentDeviceId();
        if (!deviceId || isDeviceIdTemporary()) {
          throw new Error('Identifiant d’appareil encore temporaire.');
        }

        const lifecycle = await recoverStableDeviceLifecycle(user.id, deviceId);
        if (lifecycle.state !== 'approved') {
          throw new Error(`DEVICE_LIFECYCLE_NOT_APPROVED:${lifecycle.state}`);
        }

        await resyncE2EE(user.id);
        const repaired = await repairApprovedDeviceTrust(user.id);
        const published = await publishOwnSignedDeviceList({
          signerDeviceId: lifecycle.isPrimary ? deviceId : undefined,
        });
        if (!published.ok) {
          throw new Error(`Publication de la liste signée refusée : ${published.error ?? 'erreur inconnue'}`);
        }

        const health = await inspectDeviceHealth(user.id, deviceId);
        return { deviceId, repaired, published, health };
      }, { coalesce: true });

      currentDeviceId = result.deviceId;
      console.info('[PIN-DEVTRUST] single-pass validation after PIN unlock', {
        userId: user.id.slice(0, 8),
        currentDeviceId: currentDeviceId.slice(0, 8),
        repaired: result.repaired,
        published: result.published.ok,
        lifecycle: result.health.lifecycle,
        total: result.health.totalCount,
        trusted: result.health.trustedCount,
        currentTrusted: result.health.trusted,
        hasSignedPrekey: result.health.hasSignedPrekey,
        reasons: result.health.rejectionReasons,
      });

      if (!result.health.ready) {
        setState({
          status: 'failed',
          reason: reasonForHealth(result.health),
          currentDeviceId,
          trustedCount: result.health.trustedCount,
          totalCount: result.health.totalCount,
          rejections: result.health.rejectionReasons,
        });
        return;
      }

      try {
        window.dispatchEvent(new CustomEvent('forsure:e2ee-request-refanout-scan', {
          detail: { reason: 'pin_device_trust_validated', deviceId: currentDeviceId },
        }));
        window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
          detail: { reason: 'pin_device_trust_validated' },
        }));
      } catch {}

      setState({ status: 'ready', trustedCount: result.health.trustedCount });
    } catch (error) {
      setState({
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        currentDeviceId,
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
            <p className="font-semibold">Validation des clés et des appareils…</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Vérification unique avec la clé restaurée par le PIN.
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
        <h2 className="mt-3 font-semibold">Appareil non validé</h2>
        <p className="mt-2 text-sm text-muted-foreground">{state.reason}</p>
        <div className="mt-3 rounded-xl bg-muted/50 p-3 text-left text-xs text-muted-foreground">
          <p><strong>Appareil :</strong> {state.currentDeviceId ? state.currentDeviceId.slice(0, 12) : 'indisponible'}</p>
          <p><strong>Appareils fiables :</strong> {state.trustedCount}/{state.totalCount}</p>
          {rejectionText && <p className="mt-1"><strong>Rejets :</strong> {rejectionText}</p>}
        </div>
        <p className="mt-3 flex items-center justify-center gap-1 text-xs text-muted-foreground">
          <KeyRound className="h-3.5 w-3.5" />
          La messagerie reste verrouillée pour éviter d’envoyer à un appareil non certifié.
        </p>
        <Button className="mt-4 gap-2" onClick={() => setRunId((value) => value + 1)}>
          <RefreshCw className="h-4 w-4" />
          Réparer et vérifier
        </Button>
      </div>
    </div>
  );
}
