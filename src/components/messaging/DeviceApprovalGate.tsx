import { type ReactNode } from 'react';
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

      return;
    }
    try {
      if (!getSessionMasterKey()) {
        if (status !== 'restored' && status !== 'local_ok') {
          throw new Error(status === 'no_backup'
            ? 'Aucune sauvegarde de compte disponible pour restaurer les clés.'
            : 'Mot de passe incorrect ou sauvegarde du compte illisible.');
        }
      }
      lifecycle.refresh();
    } catch (error) {
    } finally {
    }
  };

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
    // Invariant corrigé : plus aucune récupération WebAuthn. L'appareil
    // s'enrôle et se fait approuver automatiquement côté serveur.
    if (!lifecycle.error) {
      return (
        <Shell compact={compact}>
          <div className="flex flex-col items-center gap-3 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-sm font-medium">Enregistrement de cet appareil…</p>
            <p className="text-xs text-muted-foreground">Vérification cryptographique automatique en cours.</p>
          {diagnostics}
          </div>
        </Shell>
      );
    }
    return (
      <Shell compact={compact}>

        <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <Smartphone className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-base font-bold">Appareil non retrouvé</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Si vous avez supprimé les données du navigateur, cet appareil doit être enregistré à nouveau puis approuvé par le serveur.
              </p>
            </div>
          </div>

          <div className="mb-4 rounded-xl bg-muted/50 px-3 py-2.5">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Sécurité</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Le DeviceID et ses clés privées ne sont jamais recréés en silence : un nouvel enrôlement complet est exigé.
            </p>
          </div>

          <div className="mb-3">{failure}</div>

          {lifecycle.canStartEnrollment && <Button
            className="w-full rounded-xl"
            disabled={lifecycle.stage !== 'idle'}
            onClick={lifecycle.startEnrollment}
          >
            {lifecycle.stage === 'enrolling' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldQuestion className="mr-2 h-4 w-4" />}
            Enregistrer comme nouvel appareil
          </Button>}

          <p className="mt-3 text-center text-[11px] text-muted-foreground">
            Aucun nouvel identifiant n’est généré automatiquement.
          </p>
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
