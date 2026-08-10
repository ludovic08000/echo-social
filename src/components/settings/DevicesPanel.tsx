import { useCallback, useEffect, useState } from 'react';
import { Check, Monitor, Smartphone, Tablet, Loader2, ShieldCheck, Trash2, X } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth';
import { useDeviceLifecycle } from '@/hooks/useDeviceLifecycle';
import { deviceApi, type DeviceApiListRecord } from '@/lib/api/deviceApi';
import { Button } from '@/components/ui/button';
import { WindowsHelloDeviceRecoverySection } from '@/components/settings/WindowsHelloDeviceRecoverySection';
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

function platformIcon(platform: string | null, userAgent: string | null) {
  const hint = `${platform ?? ''} ${userAgent ?? ''}`.toLowerCase();
  if (hint.includes('ipad') || hint.includes('tablet')) return Tablet;
  if (hint.includes('iphone') || hint.includes('android') || hint.includes('mobile')) return Smartphone;
  return Monitor;
}

function labelForDevice(device: DeviceApiListRecord): string {
  return device.deviceName
    || device.platform
    || (device.userAgent ? device.userAgent.split(' ')[0] : 'Appareil inconnu');
}

function statusLabel(device: DeviceApiListRecord): string {
  if (device.revokedAt || !device.isActive) return 'Révoqué';
  if (device.approvalStatus === 'pending') return 'En attente';
  if (device.approvalStatus !== 'approved') return 'Non approuvé';
  if (device.bindingStatus !== 'bound') return 'Liaison requise';
  if (device.routingStatus !== 'ready') return 'Clés en préparation';
  return 'Prêt';
}

export function DevicesPanel() {
  const { user } = useAuth();
  const lifecycle = useDeviceLifecycle();
  const [devices, setDevices] = useState<DeviceApiListRecord[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);

  // Canonical current device comes from the hydrated lifecycle. Do not cache
  // deviceApi.getCurrentId() from the first render: it can legitimately be null
  // before account-scoped DeviceID hydration completes and would then remain
  // stale for the lifetime of this panel.
  const currentDeviceId = lifecycle.deviceId;

  const load = useCallback(async (background = false) => {
    if (!user?.id) {
      setDevices([]);
      setInitialLoading(false);
      setRefreshing(false);
      return;
    }

    if (background) setRefreshing(true);
    else if (devices.length === 0) setInitialLoading(true);

    try {
      setDevices(await deviceApi.listDevices(user.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Impossible de charger les appareils');
    } finally {
      setInitialLoading(false);
      setRefreshing(false);
    }
  }, [user?.id, devices.length]);

  useEffect(() => {
    void load(false);
  }, [user?.id]); // intentionally not tied to load/devices.length: first load only

  // When the canonical lifecycle changes after approval/binding/recovery, refresh
  // the rows in place without unmounting the panel or replacing it with a spinner.
  useEffect(() => {
    if (!user?.id || lifecycle.loading) return;
    void load(true);
  }, [user?.id, lifecycle.deviceId, lifecycle.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRevoke = async (device: DeviceApiListRecord) => {
    if (!user?.id) return;
    setRevoking(device.deviceId);
    try {
      await deviceApi.revokeDevice(user.id, device.deviceId);
      setDevices((current) => current.filter((item) => item.deviceId !== device.deviceId));
      toast.success('Appareil révoqué');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Échec de la révocation');
    } finally {
      setRevoking(null);
    }
  };

  const handleDecision = async (device: DeviceApiListRecord, decision: 'approve' | 'reject') => {
    if (!user?.id) return;
    setDeciding(device.deviceId);
    try {
      if (decision === 'approve') await deviceApi.approve(user.id, device.deviceId);
      else await deviceApi.reject(user.id, device.deviceId);
      await load(true);
      toast.success(decision === 'approve' ? 'Appareil approuvé' : 'Appareil refusé');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Décision impossible');
    } finally {
      setDeciding(null);
    }
  };

  if (initialLoading && devices.length === 0) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-card p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">Appareils sécurisés</h3>
              {refreshing && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Les nouveaux appareils secondaires apparaissent ici. Vous décidez explicitement de les approuver ou de les refuser depuis cet appareil reconnu.
            </p>
          </div>
        </div>
      </div>

      {user?.id && (
        <WindowsHelloDeviceRecoverySection userId={user.id} deviceId={currentDeviceId} />
      )}

      {devices.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          Aucun appareil enregistré.
        </div>
      ) : (
        <ul className="space-y-2">
          {devices.map((device) => {
            const Icon = platformIcon(device.platform, device.userAgent);
            const isCurrent = device.deviceId === currentDeviceId;
            const lastSeen = formatDistanceToNow(new Date(device.lastSeenAt), {
              addSuffix: true,
              locale: fr,
            });

            return (
              <li key={device.deviceId} className="rounded-2xl border bg-card p-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold">{labelForDevice(device)}</span>
                      {isCurrent && (
                        <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                          Cet appareil
                        </span>
                      )}
                      <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                        {device.deviceRole === 'primary' ? 'Principal' : 'Secondaire'}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{statusLabel(device)} · vu {lastSeen}</p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70">
                      {device.deviceId}
                    </p>
                  </div>

                  {!isCurrent && device.approvalStatus === 'pending' && (
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" disabled={deciding !== null} onClick={() => void handleDecision(device, 'approve')} aria-label="Approuver cet appareil">
                        {deciding === device.deviceId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      </Button>
                      <Button size="icon" variant="ghost" disabled={deciding !== null} onClick={() => void handleDecision(device, 'reject')} aria-label="Refuser cet appareil">
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  )}

                  {!isCurrent && device.approvalStatus !== 'pending' && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={revoking !== null}
                          aria-label="Révoquer cet appareil"
                        >
                          {revoking === device.deviceId
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Trash2 className="h-4 w-4" />}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Révoquer cet appareil ?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Il perdra immédiatement l’accès à la messagerie chiffrée et devra être enrôlé de nouveau pour revenir.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Annuler</AlertDialogCancel>
                          <AlertDialogAction onClick={() => void handleRevoke(device)}>
                            Révoquer
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
