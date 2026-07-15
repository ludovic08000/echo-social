import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { repairApprovedDeviceTrust } from '@/lib/crypto/deviceLinkTrust';
import {
  fetchVerifiedDeviceList,
  publishOwnSignedDeviceList,
  type DeviceVerificationResult,
} from '@/lib/crypto/signedDeviceList';
import { peekDeviceSignedPrekey } from '@/lib/crypto/x3dh';
import { getCurrentDeviceId, hydrateDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { resyncE2EE } from '@/lib/crypto/resyncE2EE';

interface PinValidatedMessagingProps {
  children: ReactNode;
}

type ValidationState =
  | { status: 'checking'; attempt: number }
  | { status: 'ready'; trustedCount: number }
  | {
      status: 'failed';
      reason: string;
      currentDeviceId: string;
      trustedCount: number;
      totalCount: number;
      rejections: Record<string, number>;
    };

const RETRY_DELAYS_MS = [0, 500, 1_500, 3_000, 5_000] as const;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rejectionCounts(results: DeviceVerificationResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    if (result.ok) continue;
    const reason = result.reason ?? 'UNKNOWN';
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

/**
 * PIN is the account-key unlock boundary. Messaging is exposed only after the
 * restored Ed25519 account identity has repaired/published the signed device
 * list and the current installation has a valid Signed PreKey.
 */
export function PinValidatedMessaging({ children }: PinValidatedMessagingProps) {
  const { user } = useAuth();
  const [runId, setRunId] = useState(0);
  const [state, setState] = useState<ValidationState>({ status: 'checking', attempt: 0 });

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

    setState({ status: 'checking', attempt: 0 });
    let lastVerified: Awaited<ReturnType<typeof fetchVerifiedDeviceList>> | null = null;
    let currentDeviceId = '';
    let lastReason = 'Appareil non validé après restauration du PIN.';

    for (let index = 0; index < RETRY_DELAYS_MS.length; index += 1) {
      await sleep(RETRY_DELAYS_MS[index]);
      setState({ status: 'checking', attempt: index + 1 });

      try {
        await hydrateDeviceId();
        currentDeviceId = getCurrentDeviceId();
        if (!currentDeviceId || isDeviceIdTemporary()) {
          lastReason = 'Identifiant d’appareil encore temporaire.';
          continue;
        }

        await resyncE2EE(user.id);
        const repaired = await repairApprovedDeviceTrust(user.id);
        const published = await publishOwnSignedDeviceList();
        if (!published.ok) {
          lastReason = `Publication de la liste signée refusée : ${published.error ?? 'erreur inconnue'}`;
          continue;
        }

        lastVerified = await fetchVerifiedDeviceList(user.id);
        const currentTrusted = lastVerified.trusted.some(
          (device) => device.deviceId === currentDeviceId,
        );
        const signedPrekey = await peekDeviceSignedPrekey(user.id, currentDeviceId).catch(() => null);

        console.info('[PIN-DEVTRUST] validation after PIN unlock', {
          userId: user.id.slice(0, 8),
          currentDeviceId: currentDeviceId.slice(0, 8),
          repaired,
          published: published.ok,
          total: lastVerified.verifications.length,
          trusted: lastVerified.trusted.length,
          currentTrusted,
          hasSignedPrekey: Boolean(signedPrekey),
          reasons: rejectionCounts(lastVerified.verifications),
        });

        if (!currentTrusted) {
          lastReason = 'L’appareil courant n’est pas signé par la clé restaurée avec le PIN.';
          continue;
        }
        if (!signedPrekey) {
          lastReason = 'La préclé signée de cet appareil est absente ou expirée.';
          continue;
        }

        try {
          window.dispatchEvent(new CustomEvent('forsure:e2ee-request-refanout-scan', {
            detail: { reason: 'pin_device_trust_validated', deviceId: currentDeviceId },
          }));
          window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
            detail: { reason: 'pin_device_trust_validated' },
          }));
        } catch {
          // UI wakeups are best-effort after cryptographic validation succeeds.
        }

        setState({ status: 'ready', trustedCount: lastVerified.trusted.length });
        return;
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error);
      }
    }

    setState({
      status: 'failed',
      reason: lastReason,
      currentDeviceId,
      trustedCount: lastVerified?.trusted.length ?? 0,
      totalCount: lastVerified?.verifications.length ?? 0,
      rejections: rejectionCounts(lastVerified?.verifications ?? []),
    });
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
              Le PIN a déverrouillé la clé du compte. Vérification cryptographique {state.attempt}/{RETRY_DELAYS_MS.length}.
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
