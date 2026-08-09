import type { ReactNode } from 'react';
import { Check, Loader2, ShieldCheck, ShieldQuestion, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useDeviceLifecycle } from '@/hooks/useDeviceLifecycle';
import { usePrePinDeviceEnrollment } from '@/hooks/usePrePinDeviceEnrollment';

interface DeviceApprovalGateProps {
  children: ReactNode;
  compact?: boolean;
}

function Shell({ children, compact }: { children: ReactNode; compact: boolean }) {
  return (
    <div className={cn(
      'flex h-full items-center justify-center overflow-y-auto bg-background',
      compact ? 'px-3 py-4' : 'min-h-[50vh] px-4 py-8',
    )}>
      <div className={cn('w-full', compact ? 'max-w-full' : 'max-w-sm')}>
        {children}
      </div>
    </div>
  );
}

export function DeviceApprovalGate({ children, compact = false }: DeviceApprovalGateProps) {
  const lifecycle = useDeviceLifecycle();
  const actions = usePrePinDeviceEnrollment(lifecycle.deviceId, lifecycle.refresh);

  if (lifecycle.loading) {
    return (
      <Shell compact={compact}>
        <div className="flex flex-col items-center gap-3 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm font-medium">Vérification de cet appareil…</p>
          <p className="text-xs text-muted-foreground">Le PIN reste bloqué pendant cette vérification.</p>
        </div>
      </Shell>
    );
  }

  if (lifecycle.state === 'DEVICE_CREDENTIAL_CHECK' || lifecycle.state === 'LINK_REQUIRED') {
    return (
      <Shell compact={compact}>
        <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <Smartphone className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-base font-bold">Nouvel appareil</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Cet appareil doit être enregistré et approuvé avant d’accéder au PIN de la messagerie.
              </p>
            </div>
          </div>

          <div className="mb-4 rounded-xl bg-muted/50 px-3 py-2.5">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Sécurité</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Le navigateur et le matériel servent seulement à décrire l’appareil. La confiance repose sur ses clés cryptographiques et sa preuve de possession.
            </p>
          </div>

          {actions.error && (
            <p className="mb-3 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">{actions.error}</p>
          )}

          <Button
            className="w-full rounded-xl"
            disabled={actions.processing}
            onClick={() => void actions.startEnrollment()}
          >
            {actions.processing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldQuestion className="mr-2 h-4 w-4" />}
            Configurer cet appareil
          </Button>

          <p className="mt-3 text-center text-[11px] text-muted-foreground">
            Aucun PIN n’est demandé avant la fin de cette étape.
          </p>
        </div>
      </Shell>
    );
  }

  if (lifecycle.state === 'PENDING_APPROVAL') {
    const pending = actions.pending;
    return (
      <Shell compact={compact}>
        <div className="rounded-2xl border border-amber-500/40 bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/10">
              <ShieldQuestion className="h-5 w-5 text-amber-700" />
            </div>
            <div>
              <h2 className="text-base font-bold">{actions.canBootstrapPrimary ? 'Confirmer le premier appareil ?' : 'Approbation requise'}</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {actions.canBootstrapPrimary
                  ? 'Aucun appareil n’existe encore. Votre confirmation créera l’unique appareil principal du compte.'
                  : 'Une alerte a été envoyée à vos appareils déjà connectés. Approuvez cette demande depuis l’un d’eux.'}
              </p>
            </div>
          </div>

          {!pending ? (
            <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Chargement de la demande…
            </div>
          ) : (
            <>
              <div className="mb-3 rounded-xl bg-muted/50 px-3 py-2.5">
                <p className="text-sm font-semibold">{pending.deviceName}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {pending.platform ?? 'web'} · {pending.deviceId.slice(0, 16)}…
                </p>
              </div>

              {pending.fingerprintLines.length > 0 && (
                <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Empreinte cryptographique</p>
                  <div className="mt-1 font-mono text-xs leading-relaxed tracking-wider">
                    {pending.fingerprintLines.map((line) => <span key={line} className="block">{line}</span>)}
                  </div>
                </div>
              )}

              {actions.error && (
                <p className="mb-3 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">{actions.error}</p>
              )}

              {actions.canBootstrapPrimary && <div className="grid grid-cols-1 gap-2">
                <Button
                  className="rounded-xl"
                  disabled={actions.processing}
                  onClick={() => void actions.decide('approve')}
                >
                  {actions.processing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Check className="mr-1.5 h-4 w-4" />}
                  Approuver
                </Button>
              </div>}
            </>
          )}

          <p className="mt-3 text-center text-[11px] text-muted-foreground">
            Le PIN apparaîtra uniquement après l’approbation.
          </p>
        </div>
      </Shell>
    );
  }

  if (!lifecycle.canPromptForPin) {
    return (
      <Shell compact={compact}>
        <div className="flex flex-col items-center gap-3 text-center">
          <ShieldCheck className="h-6 w-6 text-primary" />
          <p className="text-sm font-medium">Validation de l’appareil…</p>
        </div>
      </Shell>
    );
  }

  return <>{children}</>;
}
