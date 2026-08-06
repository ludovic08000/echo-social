import { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyRound,
  Loader2,
  MonitorCheck,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import {
  getCurrentDeviceId,
  getCurrentDeviceLabel,
  hydrateDeviceId,
} from '@/lib/messaging/currentDevice';
import { submitAccountIdentityDeviceApproval } from '@/lib/crypto/deviceApprovalDecision';
import { Button } from '@/components/ui/button';

const SERVER_DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
const STATUS_POLL_MS = 5_000;

type GatePhase =
  | 'hidden'
  | 'checking'
  | 'pending'
  | 'recovering'
  | 'syncing'
  | 'revoked'
  | 'sync_failed';
type AccountSyncPhase = 'idle' | 'syncing' | 'ready' | 'failed';

type CurrentDeviceRow = {
  device_id: string;
  device_name: string | null;
  device_public_key: string | null;
  device_signing_key: string | null;
  approval_challenge_id: string | null;
  platform: string | null;
  approval_status: string | null;
  approval_requested_at: string | null;
  approved_at: string | null;
  is_active: boolean | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  routing_status: string | null;
};

function isRevoked(row: CurrentDeviceRow): boolean {
  return Boolean(row.revoked_at) || row.approval_status === 'rejected';
}

export function PendingDeviceApprovalGate() {
  const { user } = useAuth();
  const [phase, setPhase] = useState<GatePhase>('hidden');
  const [row, setRow] = useState<CurrentDeviceRow | null>(null);
  const [deviceId, setDeviceId] = useState(() => getCurrentDeviceId());
  const [serverAccountExists, setServerAccountExists] = useState<boolean | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const pendingObservedRef = useRef(false);
  const syncStateRef = useRef<AccountSyncPhase>('idle');
  const recoveryRequestedRef = useRef(false);
  const recoveryInFlightRef = useRef(false);

  const inspect = useCallback(async (source: string) => {
    if (!user?.id) {
      setPhase('hidden');
      setRow(null);
      setServerAccountExists(null);
      return;
    }

    const hydrated = await hydrateDeviceId().catch(() => getCurrentDeviceId());
    setDeviceId(hydrated);
    if (!SERVER_DEVICE_ID_RE.test(hydrated)) {
      if (!pendingObservedRef.current) setPhase('hidden');
      return;
    }

    const [deviceResult, accountResult] = await Promise.all([
      supabase
        .from('user_devices')
        .select('device_id,device_name,device_public_key,device_signing_key,approval_challenge_id,platform,approval_status,approval_requested_at,approved_at,is_active,revoked_at,revoke_reason,routing_status')
        .eq('user_id', user.id)
        .eq('device_id', hydrated)
        .maybeSingle(),
      supabase
        .from('user_public_keys')
        .select('fingerprint')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (deviceResult.error) {
      console.warn('[PendingDeviceApprovalGate] status lookup failed', {
        source,
        error: deviceResult.error,
      });
      return;
    }
    if (accountResult.error) {
      console.warn('[PendingDeviceApprovalGate] account lookup failed', {
        source,
        error: accountResult.error,
      });
    } else {
      setServerAccountExists(Boolean(accountResult.data?.fingerprint));
    }
    if (!deviceResult.data) return;

    const current = deviceResult.data as unknown as CurrentDeviceRow;
    let nextPhase: GatePhase = 'checking';
    if (isRevoked(current)) {
      nextPhase = 'revoked';
    } else if (current.approval_status === 'pending') {
      nextPhase = recoveryInFlightRef.current ? 'recovering' : 'pending';
    } else if (current.approval_status === 'approved' && current.is_active === true) {
      if (syncStateRef.current === 'failed') {
        nextPhase = 'sync_failed';
      } else if (pendingObservedRef.current && syncStateRef.current !== 'ready') {
        nextPhase = 'syncing';
      } else {
        nextPhase = current.routing_status === 'ready' ? 'hidden' : 'syncing';
      }
    }

    setRow(current);
    setPhase(nextPhase);
    if (
      nextPhase === 'pending'
      || nextPhase === 'recovering'
      || nextPhase === 'syncing'
      || nextPhase === 'sync_failed'
    ) {
      pendingObservedRef.current = true;
    } else if (nextPhase === 'revoked' || nextPhase === 'hidden') {
      pendingObservedRef.current = false;
    }
  }, [user?.id]);

  const approveWithRecoveredAccount = useCallback(async () => {
    if (!user?.id || !row || recoveryInFlightRef.current) return;
    if (
      !row.device_public_key
      || !row.device_signing_key
      || !row.approval_challenge_id
    ) {
      setRecoveryError('La demande d’approbation est incomplète.');
      return;
    }

    recoveryInFlightRef.current = true;
    recoveryRequestedRef.current = true;
    setRecoveryError(null);
    setPhase('recovering');

    try {
      const result = await submitAccountIdentityDeviceApproval({
        userId: user.id,
        target: {
          deviceId: row.device_id,
          challengeId: row.approval_challenge_id,
          devicePublicKey: row.device_public_key,
          deviceSigningKey: row.device_signing_key,
        },
      });

      recoveryRequestedRef.current = false;
      pendingObservedRef.current = true;
      syncStateRef.current = 'syncing';
      setPhase('syncing');
      window.dispatchEvent(new CustomEvent('forsure:authenticated-device-enroll', {
        detail: {
          userId: user.id,
          source: result.mode === 'first_device_bootstrap'
            ? 'first-device-bootstrap-approved'
            : 'account-recovery-device-approved',
        },
      }));
      await inspect('account-identity-approval-complete');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recoveryInFlightRef.current = false;
      setPhase('pending');

      if (
        message.includes('ACCOUNT_RECOVERY_KEYS_REQUIRED')
        || message.toLowerCase().includes('pin unlock')
      ) {
        window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', {
          detail: {
            userId: user.id,
            reason: 'pending_device_account_recovery',
            source: 'pending-device-approval-gate',
            allowPendingDeviceRecovery: true,
            deviceId: row.device_id,
          },
        }));
        return;
      }

      recoveryRequestedRef.current = false;
      setRecoveryError(message);
    } finally {
      recoveryInFlightRef.current = false;
    }
  }, [inspect, row, user?.id]);

  useEffect(() => {
    if (!user?.id) {
      setPhase('hidden');
      setRow(null);
      setServerAccountExists(null);
      pendingObservedRef.current = false;
      syncStateRef.current = 'idle';
      recoveryRequestedRef.current = false;
      recoveryInFlightRef.current = false;
      return;
    }

    let disposed = false;
    const safeInspect = (source: string) => {
      if (!disposed) void inspect(source);
    };

    const onPending = (event: Event) => {
      const detail = (event as CustomEvent<{ deviceId?: string }>).detail;
      if (detail?.deviceId) setDeviceId(detail.deviceId);
      pendingObservedRef.current = true;
      syncStateRef.current = 'idle';
      setPhase('pending');
      safeInspect('pending-event');
    };

    const onApproved = () => {
      syncStateRef.current = 'ready';
      pendingObservedRef.current = false;
      recoveryRequestedRef.current = false;
      setPhase('hidden');
    };

    const onRevoked = (event: Event) => {
      const detail = (event as CustomEvent<{ deviceId?: string }>).detail;
      if (detail?.deviceId && detail.deviceId !== getCurrentDeviceId()) return;
      pendingObservedRef.current = false;
      syncStateRef.current = 'idle';
      recoveryRequestedRef.current = false;
      setPhase('revoked');
      safeInspect('revoked-event');
    };

    const onSyncState = (event: Event) => {
      const detail = (event as CustomEvent<{
        userId?: string;
        phase?: AccountSyncPhase;
      }>).detail;
      if (detail?.userId && detail.userId !== user.id) return;
      if (!detail?.phase) return;
      syncStateRef.current = detail.phase;
      if (detail.phase === 'syncing') {
        pendingObservedRef.current = true;
        setPhase('syncing');
      }
      if (detail.phase === 'ready') {
        pendingObservedRef.current = false;
        recoveryRequestedRef.current = false;
        setPhase('hidden');
      }
      if (detail.phase === 'failed') {
        pendingObservedRef.current = true;
        setPhase('sync_failed');
      }
    };

    const onKeysAvailable = () => {
      if (!recoveryRequestedRef.current) return;
      void approveWithRecoveredAccount();
    };

    window.addEventListener('forsure:e2ee-device-pending', onPending);
    window.addEventListener('forsure:e2ee-device-approved', onApproved);
    window.addEventListener('forsure:current-device-revoked', onRevoked);
    window.addEventListener('forsure:account-sync-state', onSyncState);
    window.addEventListener('forsure-keys-restored', onKeysAvailable);
    window.addEventListener('forsure-keys-unlocked', onKeysAvailable);

    const channel = supabase
      .channel(`pending-device-gate:${user.id}:${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_devices',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const changed = (payload.new || payload.old) as Partial<CurrentDeviceRow>;
          if (changed.device_id && changed.device_id !== getCurrentDeviceId()) return;
          safeInspect('realtime');
        },
      )
      .subscribe();

    const poll = window.setInterval(() => safeInspect('poll'), STATUS_POLL_MS);
    safeInspect('mount');

    return () => {
      disposed = true;
      window.clearInterval(poll);
      void supabase.removeChannel(channel);
      window.removeEventListener('forsure:e2ee-device-pending', onPending);
      window.removeEventListener('forsure:e2ee-device-approved', onApproved);
      window.removeEventListener('forsure:current-device-revoked', onRevoked);
      window.removeEventListener('forsure:account-sync-state', onSyncState);
      window.removeEventListener('forsure-keys-restored', onKeysAvailable);
      window.removeEventListener('forsure-keys-unlocked', onKeysAvailable);
    };
  }, [approveWithRecoveredAccount, inspect, user?.id]);

  if (!user || phase === 'hidden') return null;

  const label = row?.device_name || getCurrentDeviceLabel() || 'Cet appareil';
  const shortId = deviceId && SERVER_DEVICE_ID_RE.test(deviceId)
    ? `${deviceId.slice(0, 12)}…${deviceId.slice(-6)}`
    : 'Attribution en cours';
  const isFirstDevice = serverAccountExists === false;

  const signOut = async () => {
    await supabase.auth.signOut().catch(() => undefined);
    window.location.assign('/login');
  };

  const retrySynchronization = () => {
    syncStateRef.current = 'syncing';
    pendingObservedRef.current = true;
    setPhase('syncing');
    window.dispatchEvent(new CustomEvent('forsure:authenticated-device-enroll', {
      detail: { userId: user.id, source: 'pending-device-gate-sync-retry' },
    }));
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex min-h-[100dvh] items-center justify-center overflow-y-auto bg-background/98 px-4 py-8 backdrop-blur-xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pending-device-title"
    >
      <div className="w-full max-w-md rounded-[2rem] border border-border/60 bg-card p-6 shadow-2xl sm:p-8">
        {phase === 'pending' && (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500/12 text-amber-700">
              <Smartphone className="h-8 w-8" />
            </div>
            <div className="mt-5 text-center">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-amber-700">
                {isFirstDevice ? 'Premier appareil sécurisé' : 'En attente d’approbation'}
              </p>
              <h1 id="pending-device-title" className="mt-2 text-2xl font-bold">
                {isFirstDevice ? 'Activer cet appareil' : 'Nouvel appareil détecté'}
              </h1>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                <strong className="text-foreground">{label}</strong>{' '}
                {isFirstDevice
                  ? 'sera le premier appareil lié à l’identité chiffrée de ce compte.'
                  : 'est enregistré, mais n’a encore aucun accès à vos messages chiffrés.'}
              </p>
            </div>

            {!isFirstDevice && (
              <div className="mt-6 rounded-2xl border border-border/50 bg-muted/45 p-4">
                <div className="flex gap-3">
                  <MonitorCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                  <div>
                    <p className="text-sm font-semibold">Depuis un autre appareil déjà approuvé</p>
                    <ol className="mt-2 space-y-1 text-sm leading-5 text-muted-foreground">
                      <li>1. Ouvrez ForSure sur cet autre téléphone, ordinateur ou tablette.</li>
                      <li>2. Allez dans Réglages → Appareils connectés.</li>
                      <li>3. Appuyez sur <strong className="text-foreground">Approuver</strong>.</li>
                    </ol>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-4 rounded-2xl bg-primary/10 p-4 text-sm leading-5 text-muted-foreground">
              {isFirstDevice
                ? 'La clé racine créée pour ce compte signera cet appareil. Le serveur ne reçoit aucune clé privée.'
                : 'Aucun autre appareil disponible ? Restaurez l’identité du compte avec votre mot de passe ou votre clé de récupération. La clé racine restaurée signera exactement cette demande.'}
            </div>

            {recoveryError && (
              <p role="alert" className="mt-4 rounded-xl bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">
                {recoveryError}
              </p>
            )}

            <Button
              className="mt-5 w-full rounded-xl"
              onClick={() => void approveWithRecoveredAccount()}
            >
              <KeyRound className="mr-2 h-4 w-4" />
              {isFirstDevice ? 'Activer ce premier appareil' : 'Récupérer ce compte'}
            </Button>

            <div className="mt-4 flex items-center justify-between rounded-xl border border-border/40 px-3 py-2 text-xs text-muted-foreground">
              <span>{shortId}</span>
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Vérification automatique
              </span>
            </div>

            <Button variant="outline" className="mt-3 w-full rounded-xl" onClick={() => void inspect('manual-refresh')}>
              <RefreshCw className="mr-2 h-4 w-4" /> Actualiser maintenant
            </Button>
          </>
        )}

        {(phase === 'checking' || phase === 'recovering' || phase === 'syncing') && (
          <div className="py-5 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              {phase === 'syncing'
                ? <ShieldCheck className="h-8 w-8" />
                : <Loader2 className="h-8 w-8 animate-spin" />}
            </div>
            <h1 id="pending-device-title" className="mt-5 text-2xl font-bold">
              {phase === 'syncing'
                ? 'Appareil approuvé'
                : phase === 'recovering'
                  ? 'Vérification de l’identité du compte'
                  : 'Vérification de l’appareil'}
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              {phase === 'syncing'
                ? 'Restauration de l’identité commune et synchronisation sécurisée du compte…'
                : phase === 'recovering'
                  ? 'Validation cryptographique de la clé racine et de la demande de cet appareil…'
                  : 'Contrôle du statut cryptographique de cet appareil…'}
            </p>
            <Loader2 className="mx-auto mt-6 h-6 w-6 animate-spin text-primary" />
          </div>
        )}

        {phase === 'sync_failed' && (
          <div className="py-4 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
              <ShieldAlert className="h-8 w-8" />
            </div>
            <h1 id="pending-device-title" className="mt-5 text-2xl font-bold">Synchronisation interrompue</h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              L’appareil reste bloqué tant que la synchronisation sécurisée n’est pas terminée.
            </p>
            <Button className="mt-6 w-full rounded-xl" onClick={retrySynchronization}>
              <RefreshCw className="mr-2 h-4 w-4" /> Réessayer
            </Button>
          </div>
        )}

        {phase === 'revoked' && (
          <div className="py-4 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
              <ShieldAlert className="h-8 w-8" />
            </div>
            <p className="mt-5 text-xs font-bold uppercase tracking-[0.2em] text-destructive">Accès refusé</p>
            <h1 id="pending-device-title" className="mt-2 text-2xl font-bold">Appareil révoqué</h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Un appareil déjà approuvé a refusé cette demande. Cet appareil ne peut ni recevoir
              ni envoyer de messages chiffrés pour ce compte.
            </p>
            {row?.revoke_reason && (
              <p className="mt-4 rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">
                Motif : {row.revoke_reason}
              </p>
            )}
            <Button variant="destructive" className="mt-6 w-full rounded-xl" onClick={() => void signOut()}>
              Retour à la connexion
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
