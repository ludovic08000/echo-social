/**
 * Device registry and trusted-device approval UI.
 * Pending devices are never routable and can only be approved or rejected by
 * another active, approved device whose local Ed25519 key signs the decision.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  Loader2,
  Monitor,
  ShieldOff,
  ShieldQuestion,
  Smartphone,
  Tablet,
  Trash2,
  X,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { getCurrentDeviceId, hydrateDeviceId } from '@/lib/messaging/currentDevice';
import { invalidateDeviceSession } from '@/lib/crypto/deviceRatchet';
import {
  submitDeviceApprovalDecision,
  type DeviceApprovalDecision,
} from '@/lib/crypto/deviceApprovalDecision';
import { invalidateAllFanoutRoutes } from '@/lib/messaging/fanoutRouteCache';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

interface DeviceRow {
  id: string;
  device_id: string;
  device_name: string | null;
  device_public_key: string | null;
  device_signing_key: string | null;
  approval_challenge_id: string | null;
  approval_status: string | null;
  approval_requested_at: string | null;
  platform: string | null;
  user_agent: string | null;
  last_seen_at: string;
  created_at: string;
  is_active: boolean;
  stale_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  routing_status: string | null;
}

function platformIcon(platform: string | null, ua: string | null) {
  const hint = `${platform ?? ''} ${ua ?? ''}`.toLowerCase();
  if (hint.includes('ipad') || hint.includes('tablet')) return Tablet;
  if (hint.includes('iphone') || hint.includes('android') || hint.includes('mobile')) return Smartphone;
  return Monitor;
}

function labelForDevice(dev: DeviceRow): string {
  return dev.device_name
    || dev.platform
    || (dev.user_agent ? dev.user_agent.split(' ')[0] : 'Appareil inconnu');
}

function isPending(dev: DeviceRow): boolean {
  return dev.approval_status === 'pending' && !dev.revoked_at;
}

function isApproved(dev: DeviceRow): boolean {
  return dev.approval_status === 'approved' && dev.is_active && !dev.revoked_at;
}

export function DevicesPanel() {
  const { user } = useAuth();
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [currentDeviceId, setCurrentDeviceId] = useState(() => getCurrentDeviceId());

  const load = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const hydratedDeviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
      setCurrentDeviceId(hydratedDeviceId);

      const columns = 'id,device_id,device_name,device_public_key,device_signing_key,approval_challenge_id,approval_status,approval_requested_at,platform,user_agent,last_seen_at,created_at,is_active,stale_at,revoked_at,revoke_reason,routing_status' as const;
      const { data, error } = await supabase
        .from('user_devices')
        .select(columns)
        .eq('user_id', user.id)
        .is('revoked_at', null)
        .order('last_seen_at', { ascending: false });
      if (error) {
        console.error('[DevicesPanel] LOAD_FAILED', {
          table: 'user_devices',
          columns,
          userId: user.id,
          deviceId: hydratedDeviceId,
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        });
        toast.error(`Appareils: ${error.code ?? 'DB_ERROR'} · ${error.message}`);
      } else {
        setDevices((data ?? []) as unknown as DeviceRow[]);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    if (!user?.id) return;

    const channel = supabase
      .channel(`devices-panel:${user.id}:${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_devices',
          filter: `user_id=eq.${user.id}`,
        },
        () => void load(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const currentDevice = useMemo(
    () => devices.find((device) => device.device_id === currentDeviceId) ?? null,
    [currentDeviceId, devices],
  );
  const currentCanApprove = currentDevice ? isApproved(currentDevice) : false;
  const pendingDevices = devices.filter(isPending);
  const approvedDevices = devices.filter(isApproved);

  const handleDecision = async (dev: DeviceRow, decision: DeviceApprovalDecision) => {
    if (!user) return;
    if (dev.device_id === currentDeviceId) {
      toast.error('Un nouvel appareil ne peut pas s’approuver lui-même');
      return;
    }
    if (!currentCanApprove) {
      toast.error('Cette décision doit être prise depuis un appareil déjà approuvé');
      return;
    }
    if (!dev.approval_challenge_id || !dev.device_public_key || !dev.device_signing_key) {
      toast.error('La demande d’approbation est incomplète');
      return;
    }

    setDeciding(`${decision}:${dev.device_id}`);
    try {
      await submitDeviceApprovalDecision({
        userId: user.id,
        approverDeviceId: currentDeviceId,
        target: {
          deviceId: dev.device_id,
          challengeId: dev.approval_challenge_id,
          devicePublicKey: dev.device_public_key,
          deviceSigningKey: dev.device_signing_key,
        },
        decision,
      });

      invalidateAllFanoutRoutes();
      if (decision === 'approve') {
        toast.success('Appareil approuvé — synchronisation du compte déclenchée');
      } else {
        toast.success('Appareil refusé et révoqué');
      }
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Décision impossible');
    } finally {
      setDeciding(null);
    }
  };

  const handleRevoke = async (dev: DeviceRow) => {
    if (!user) return;
    if (dev.device_id === currentDeviceId) {
      toast.error('Vous ne pouvez pas révoquer l’appareil actuel');
      return;
    }
    setRevoking(dev.device_id);
    try {
      const { data, error } = await supabase.rpc('revoke_user_device' as never, {
        p_device_id: dev.device_id,
      } as never);
      const result = data as { ok?: boolean } | null;
      if (error || result?.ok !== true) {
        throw error ?? new Error('DEVICE_REVOCATION_REJECTED');
      }

      invalidateAllFanoutRoutes();
      window.dispatchEvent(new CustomEvent('forsure:aegis-route-ready', {
        detail: { reason: 'device-revoked', deviceId: currentDeviceId },
      }));

      try {
        await invalidateDeviceSession(user.id, currentDeviceId, user.id, dev.device_id);
      } catch {
        // Local peer-session invalidation is best-effort.
      }

      toast.success('Appareil révoqué');
      setDevices((previous) => previous.filter((device) => device.device_id !== dev.device_id));
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Échec de la révocation');
    } finally {
      setRevoking(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {pendingDevices.length > 0 && (
        <section className="space-y-2">
          <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
            <div className="flex items-start gap-3">
              <ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
              <div>
                <h3 className="text-sm font-semibold">Nouvel appareil détecté</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Vérifiez l’appareil avant de lui donner accès à la messagerie chiffrée.
                  Refuser entraîne sa révocation immédiate.
                </p>
              </div>
            </div>
          </div>

          <ul className="space-y-2">
            {pendingDevices.map((dev) => {
              const Icon = platformIcon(dev.platform, dev.user_agent);
              const isCurrent = dev.device_id === currentDeviceId;
              const label = labelForDevice(dev);
              const requestedAt = dev.approval_requested_at || dev.created_at;
              const requested = formatDistanceToNow(new Date(requestedAt), {
                addSuffix: true,
                locale: fr,
              });
              const approving = deciding === `approve:${dev.device_id}`;
              const rejecting = deciding === `reject:${dev.device_id}`;

              return (
                <li key={dev.device_id} className="rounded-2xl border border-amber-500/30 bg-card p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-700">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold">{label}</span>
                        <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700">
                          En attente
                        </span>
                        {isCurrent && (
                          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                            Cet appareil
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">Demande reçue {requested}</p>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
                        {dev.platform ?? 'web'} · {dev.device_id.slice(0, 12)}…
                      </p>
                    </div>
                  </div>

                  {isCurrent ? (
                    <p className="mt-3 rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                      Approuvez cet appareil depuis un appareil déjà reconnu, par exemple votre Windows.
                    </p>
                  ) : (
                    <div className="mt-3 flex gap-2">
                      <Button
                        size="sm"
                        className="flex-1 rounded-xl"
                        disabled={!currentCanApprove || deciding !== null}
                        onClick={() => void handleDecision(dev, 'approve')}
                      >
                        {approving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Check className="mr-1.5 h-4 w-4" />}
                        Approuver
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="flex-1 rounded-xl"
                        disabled={!currentCanApprove || deciding !== null}
                        onClick={() => void handleDecision(dev, 'reject')}
                      >
                        {rejecting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <X className="mr-1.5 h-4 w-4" />}
                        Refuser
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Appareils approuvés et autorisés à recevoir les copies chiffrées de vos messages.
        </p>

        {approvedDevices.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Aucun appareil approuvé.</p>
        ) : (
          <ul className="space-y-2">
            {approvedDevices.map((dev) => {
              const Icon = platformIcon(dev.platform, dev.user_agent);
              const isCurrent = dev.device_id === currentDeviceId;
              const isStale = Boolean(dev.stale_at);
              const lastSeen = formatDistanceToNow(new Date(dev.last_seen_at), {
                addSuffix: true,
                locale: fr,
              });
              const label = labelForDevice(dev);

              return (
                <li
                  key={dev.device_id}
                  className={cn(
                    'flex items-start gap-3 rounded-2xl border bg-card p-3.5',
                    isCurrent ? 'border-primary/40 bg-primary/5' : 'border-border/40',
                  )}
                >
                  <div className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
                    isCurrent ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                  )}>
                    <Icon className="h-5 w-5" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold">{label}</span>
                      {isCurrent && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                          <BadgeCheck className="h-3 w-3" />
                          Actuel
                        </span>
                      )}
                      {isStale && !isCurrent && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700">
                          <AlertTriangle className="h-3 w-3" />
                          Inactif
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">Dernière activité {lastSeen}</p>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
                      {dev.platform ?? 'web'} · {dev.routing_status ?? 'inconnu'}
                    </p>
                  </div>

                  {!isCurrent && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 rounded-xl text-destructive hover:bg-destructive/10 hover:text-destructive"
                          disabled={revoking === dev.device_id}
                        >
                          {revoking === dev.device_id
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Trash2 className="h-4 w-4" />}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle className="flex items-center gap-2">
                            <ShieldOff className="h-5 w-5 text-destructive" />
                            Révoquer cet appareil ?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            L’appareil <strong>{label}</strong> ne pourra plus déchiffrer les nouveaux messages.
                            Cette action est immédiate.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Annuler</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => void handleRevoke(dev)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Révoquer
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
