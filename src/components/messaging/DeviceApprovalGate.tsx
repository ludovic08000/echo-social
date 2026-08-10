import { useState, type ReactNode } from 'react';
import { Check, Fingerprint, Loader2, ShieldCheck, ShieldQuestion, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { useDeviceLifecycle } from '@/hooks/useDeviceLifecycle';
import { usePrePinDeviceEnrollment } from '@/hooks/usePrePinDeviceEnrollment';
import { getSessionMasterKey, initAccountKeySync } from '@/lib/crypto/accountKeyBackup';
import {
  isWindowsWeb,
  recoverCurrentWindowsHelloDevice,
} from '@/lib/crypto/windowsHelloDeviceRecovery';

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
  const { user } = useAuth();
  const lifecycle = useDeviceLifecycle();
  const actions = usePrePinDeviceEnrollment(lifecycle.deviceId, lifecycle.refresh);
  const [recovering, setRecovering] = useState(false);
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [showRecoveryPassword, setShowRecoveryPassword] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  const recoverWithWindowsHello = async () => {
    if (!user?.id || recovering) return;
    setRecoveryError(null);
    if (!getSessionMasterKey() && !recoveryPassword) {
      setShowRecoveryPassword(true);
      return;
    }
    setRecovering(true);
    try {
      if (!getSessionMasterKey()) {
        const status = await initAccountKeySync(recoveryPassword, user.id);
        if (status !== 'restored' && status !== 'local_ok') {
          throw new Error(status === 'no_backup'
            ? 'Aucune sauvegarde de compte disponible pour restaurer les clés.'
            : 'Mot de passe incorrect ou sauvegarde du compte illisible.');
        }
      }
      await recoverCurrentWindowsHelloDevice(user.id);
      setRecoveryPassword('');
      setShowRecoveryPassword(false);
      lifecycle.refresh();
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : 'WEBAUTHN_DEVICE_RECOVERY_FAILED');
    } finally {
      setRecovering(false);
    }
  };

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
              <h2 className="text-base font-bold">Appareil non retrouvé</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Si vous avez supprimé les données du navigateur, restaurez d’abord le même appareil avec Windows Hello. Un nouvel enrôlement ne doit être créé que si cette récupération est impossible.
              </p>
            </div>
          </div>

          <div className="mb-4 rounded-xl bg-muted/50 px-3 py-2.5">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Sécurité</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Le DeviceID et ses clés privées sont restaurés uniquement après preuve Windows Hello et vérification du coffre chiffré du compte.
            </p>
          </div>

          {(actions.error || recoveryError) && (
            <p className="mb-3 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {recoveryError ?? actions.error}
            </p>
          )}

          {isWindowsWeb() && (
            <div className="mb-3 space-y-2">
              {showRecoveryPassword && !getSessionMasterKey() && (
                <Input
                  type="password"
                  autoComplete="current-password"
                  value={recoveryPassword}
                  disabled={recovering}
                  onChange={(event) => setRecoveryPassword(event.target.value)}
                  placeholder="Mot de passe du compte"
                />
              )}
              <Button
                variant="outline"
                className="w-full rounded-xl"
                disabled={recovering || actions.processing}
                onClick={() => void recoverWithWindowsHello()}
              >
                {recovering ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Fingerprint className="mr-2 h-4 w-4" />}
                Reconnaître cet appareil avec Windows Hello
              </Button>
              <p className="text-center text-[10px] text-muted-foreground">ou, uniquement si cet appareil n’a jamais été enregistré</p>
            </div>
          )}

          <Button
            className="w-full rounded-xl"
            disabled={actions.processing || recovering}
            onClick={() => void actions.startEnrollment()}
          >
            {actions.processing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldQuestion className="mr-2 h-4 w-4" />}
            Enregistrer comme nouvel appareil
          </Button>

          <p className="mt-3 text-center text-[11px] text-muted-foreground">
            Aucun nouvel identifiant n’est généré automatiquement.
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
              <h2 className="text-base font-bold">{actions.canBootstrapPrimary ? 'Confirmer le premier appareil ?' : 'En attente d’approbation sur un appareil déjà approuvé'}</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {actions.canBootstrapPrimary
                  ? 'Aucun appareil n’existe encore. Votre confirmation créera l’unique appareil principal du compte.'
                  : 'Ouvrez Echo Social sur un appareil déjà reconnu : une demande d’approbation y apparaîtra automatiquement. Comparez l’empreinte ci-dessous avant d’approuver. Cet appareil ne peut pas s’approuver lui-même.'}
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
