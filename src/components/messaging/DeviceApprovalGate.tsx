import type { ReactNode } from 'react';
import { Loader2, ShieldQuestion, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useDeviceLifecycle } from '@/hooks/useDeviceLifecycle';
import {
  DeviceFinalizationDiagnostics,
  useFinalizationStall,
} from '@/components/messaging/DeviceFinalizationDiagnostics';

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

/**
 * Invariant cryptographique : cet écran n'exécute plus aucune transition. Il
 * reflète l'état serveur exposé par l'autorité unique du cycle de vie et sort
 * dès que l'étape est réellement terminée. Une erreur serveur est toujours
 * affichée avec un bouton Réessayer, jamais remplacée par une attente infinie.
 */
export function DeviceApprovalGate({ children, compact = false }: DeviceApprovalGateProps) {
  const lifecycle = useDeviceLifecycle();

  const failure = (
    <ErrorBlock error={lifecycle.error} onRetry={lifecycle.retry} />
  );

  // Diagnostic visible uniquement en cas d'erreur ou d'étape anormalement longue.
  const stalled = useFinalizationStall(!lifecycle.error && !lifecycle.canPromptForPin);
  const diagnostics = (lifecycle.error || stalled)
    ? <DeviceFinalizationDiagnostics open={Boolean(lifecycle.error)} />
    : null;

  if (lifecycle.loading) {
    return (
      <Shell compact={compact}>
        <div className="flex flex-col items-center gap-3 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm font-medium">Vérification de cet appareil…</p>
          <p className="text-xs text-muted-foreground">Vérification de l’état cryptographique en cours.</p>
          {diagnostics}
        </div>
      </Shell>
    );
  }

  if (lifecycle.state === 'DEVICE_CREDENTIAL_CHECK' || lifecycle.state === 'LINK_REQUIRED') {
    if (lifecycle.error) {
      return (
        <Shell compact={compact}>
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-sm font-medium">Initialisation Aegis interrompue</p>
            {failure}
            {diagnostics}
          </div>
        </Shell>
      );
    }

    if (lifecycle.state === 'LINK_REQUIRED' && lifecycle.stage === 'idle') {
      return (
        <Shell compact={compact}>
          <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                <Smartphone className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h2 className="text-base font-bold">Nouvel enrôlement Aegis requis</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  L’ancien état local ne peut plus être utilisé. Un nouveau DeviceID et de nouvelles clés Libsignal seront créés sur cet appareil.
                </p>
              </div>
            </div>
            {lifecycle.canStartEnrollment && (
              <Button className="w-full rounded-xl" onClick={lifecycle.startEnrollment}>
                <ShieldQuestion className="mr-2 h-4 w-4" />
                Créer les clés Aegis
              </Button>
            )}
            {diagnostics}
          </div>
        </Shell>
      );
    }

    return (
      <Shell compact={compact}>
        <div className="flex flex-col items-center gap-3 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm font-medium">Initialisation de Libsignal…</p>
          <p className="text-xs text-muted-foreground">Attribution du DeviceID et création locale des clés Aegis en cours.</p>
          {diagnostics}
        </div>
      </Shell>
    );
  }

  // Invariant cryptographique modifié : plus d'écran d'attente d'approbation.
  // L'appareil demande son approbation au serveur, qui seul décide.
  if (lifecycle.state === 'PENDING_APPROVAL') {
    return (
      <Shell compact={compact}>
        <div className="flex flex-col items-center gap-3 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm font-medium">Activation de cet appareil…</p>
          <p className="text-xs text-muted-foreground">
            Vérification cryptographique et activation automatique en cours.
          </p>
          {failure}
          {diagnostics}
        </div>
      </Shell>
    );
  }

  if (!lifecycle.canPromptForPin) {
    // Invariant cryptographique : cette garde s'arrête exactement à l'étape
    // APPROVED_LOCKED. Le PIN, le binding, la préparation des clés puis la
    // synchronisation de compte sont validés en aval, dans l'ordre canonique.
    return (
      <Shell compact={compact}>
        <div className="flex flex-col items-center gap-3 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm font-medium">Vérification de cet appareil…</p>
          <p className="text-xs text-muted-foreground">Contrôle de l’état serveur en cours.</p>
          {failure}
          {diagnostics}
        </div>
      </Shell>
    );
  }

  return <>{children}</>;
}

function ErrorBlock({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  if (!error) return null;
  return (
    <div className="space-y-2 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <p>{error}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Réessayer
      </Button>
    </div>
  );
}
