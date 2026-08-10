import { useCallback, useEffect, useState } from 'react';
import { Check, Monitor, Smartphone, Tablet, Loader2, ShieldCheck, Trash2, X, ChevronDown, ChevronUp, Copy, RefreshCw } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth';
import { useDeviceLifecycle } from '@/hooks/useDeviceLifecycle';
import { deviceApi, type DeviceApiListRecord } from '@/lib/api/deviceApi';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { WindowsHelloDeviceRecoverySection } from '@/components/settings/WindowsHelloDeviceRecoverySection';
import { IosPasskeyRecoverySection } from '@/components/settings/IosPasskeyRecoverySection';
import { IosDeviceDiagnosticsSection } from '@/components/settings/IosDeviceDiagnosticsSection';
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

type DeviceDiagnostic = {
  routingError: string | null;
  lifecycleStatus: string | null;
  spkCount: number;
  opkCount: number;
  webauthnCount: number;
  loadedAt: string;
  error: string | null;
};

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

function diagnosticLine(ok: boolean, okLabel: string, badLabel: string) {
  return <span className={ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>{ok ? `✓ ${okLabel}` : `• ${badLabel}`}</span>;
}

export function DevicesPanel() {
  const { user } = useAuth();
  const lifecycle = useDeviceLifecycle();
  const [devices, setDevices] = useState<DeviceApiListRecord[]>([]);
  const [diagnostics, setDiagnostics] = useState<Record<string, DeviceDiagnostic>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);

  const currentDeviceId = lifecycle.deviceId;

  const loadDiagnostics = useCallback(async (rows: DeviceApiListRecord[]) => {
    if (!user?.id || rows.length === 0) {
      setDiagnostics({});
      return;
    }

    const next: Record<string, DeviceDiagnostic> = {};
    const rpId = typeof window !== 'undefined' ? window.location.hostname.toLowerCase() : '';

    await Promise.all(rows.map(async (device) => {
      try {
        const [deviceState, spk, opk, webauthn] = await Promise.all([
          supabase
            .from('user_devices')
            .select('routing_error,lifecycle_status')
            .eq('user_id', user.id)
            .eq('device_id', device.deviceId)
            .maybeSingle(),
          supabase
            .from('device_signed_prekeys')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', user.id)
            .eq('device_id', device.deviceId),
          supabase
            .from('device_one_time_prekeys')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', user.id)
            .eq('device_id', device.deviceId),
          rpId
            ? supabase.rpc('webauthn_device_status' as never, {
                p_device_id: device.deviceId,
                p_rp_id: rpId,
              } as never)
            : Promise.resolve({ data: null, error: null }),
        ]);

        const firstError = deviceState.error || spk.error || opk.error || webauthn.error;
        const state = deviceState.data as { routing_error?: string | null; lifecycle_status?: string | null } | null;
        const webauthnState = webauthn.data as { registered?: boolean } | null;

        next[device.deviceId] = {
          routingError: state?.routing_error ?? null,
          lifecycleStatus: state?.lifecycle_status ?? device.lifecycleStatus ?? null,
          spkCount: spk.count ?? 0,
          opkCount: opk.count ?? 0,
          webauthnCount: webauthnState?.registered === true ? 1 : 0,
          loadedAt: new Date().toISOString(),
          error: firstError?.message ?? null,
        };
      } catch (error) {
        next[device.deviceId] = {
          routingError: null,
          lifecycleStatus: device.lifecycleStatus ?? null,
          spkCount: 0,
          opkCount: 0,
          webauthnCount: 0,
          loadedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));

    setDiagnostics(next);
  }, [user?.id]);

  const load = useCallback(async (background = false) => {
    if (!user?.id) {
      setDevices([]);
      setDiagnostics({});
      setInitialLoading(false);
      setRefreshing(false);
      return;
    }

    if (background) setRefreshing(true);
    else if (devices.length === 0) setInitialLoading(true);

    try {
      const rows = await deviceApi.listDevices(user.id);
      setDevices(rows);
      await loadDiagnostics(rows);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Impossible de charger les appareils');
    } finally {
      setInitialLoading(false);
      setRefreshing(false);
    }
  }, [user?.id, devices.length, loadDiagnostics]);

  useEffect(() => {
    void load(false);
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const copyDiagnostic = async (device: DeviceApiListRecord) => {
    const diag = diagnostics[device.deviceId];
    const report = {
      timestamp: new Date().toISOString(),
      deviceId: device.deviceId,
      deviceName: labelForDevice(device),
      current: device.deviceId === currentDeviceId,
      role: device.deviceRole,
      approvalStatus: device.approvalStatus,
      bindingStatus: device.bindingStatus,
      lifecycleStatus: diag?.lifecycleStatus ?? device.lifecycleStatus,
      routingStatus: device.routingStatus,
      routingError: diag?.routingError ?? null,
      active: device.isActive,
      revokedAt: device.revokedAt,
      spkCount: diag?.spkCount ?? null,
      opkCount: diag?.opkCount ?? null,
      webauthnActiveCredentials: diag?.webauthnCount ?? null,
      diagnosticReadError: diag?.error ?? null,
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      toast.success('Rapport diagnostic copié');
    } catch {
      toast.error('Impossible de copier le rapport');
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
          <Button size="icon" variant="ghost" onClick={() => void load(true)} disabled={refreshing} aria-label="Actualiser les diagnostics">
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {user?.id && (
        <WindowsHelloDeviceRecoverySection userId={user.id} deviceId={currentDeviceId} />
      )}

      {user?.id && (
        <IosPasskeyRecoverySection
          userId={user.id}
          deviceId={currentDeviceId}
          ready={Boolean(
            lifecycle.canRunCryptoRuntime
            && lifecycle.record?.bindingStatus === 'bound'
            && lifecycle.record?.routingStatus === 'ready'
            && lifecycle.record?.isActive
            && !lifecycle.record?.revokedAt
          )}
        />
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
            const diag = diagnostics[device.deviceId];
            const isExpanded = expanded[device.deviceId] === true;

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
                        <Button size="icon" variant="ghost" disabled={revoking !== null} aria-label="Révoquer cet appareil">
                          {revoking === device.deviceId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
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
                          <AlertDialogAction onClick={() => void handleRevoke(device)}>Révoquer</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>

                <div className="mt-3 border-t pt-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-full justify-between px-2 text-xs"
                    onClick={() => setExpanded((current) => ({ ...current, [device.deviceId]: !isExpanded }))}
                  >
                    <span>Diagnostic avancé</span>
                    {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </Button>

                  {isExpanded && (
                    <div className="mt-2 rounded-xl bg-muted/40 p-3 text-xs">
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div><span className="text-muted-foreground">Approval : </span>{diagnosticLine(device.approvalStatus === 'approved', device.approvalStatus ?? 'approved', device.approvalStatus ?? 'inconnu')}</div>
                        <div><span className="text-muted-foreground">Binding : </span>{diagnosticLine(device.bindingStatus === 'bound', 'bound', device.bindingStatus ?? 'inconnu')}</div>
                        <div><span className="text-muted-foreground">Lifecycle : </span><span className="font-mono">{diag?.lifecycleStatus ?? device.lifecycleStatus ?? 'inconnu'}</span></div>
                        <div><span className="text-muted-foreground">Routing : </span>{diagnosticLine(device.routingStatus === 'ready', 'ready', device.routingStatus ?? 'inconnu')}</div>
                        <div><span className="text-muted-foreground">SPK : </span>{diag ? diagnosticLine(diag.spkCount > 0, `${diag.spkCount} publiée(s)`, 'absente') : '…'}</div>
                        <div><span className="text-muted-foreground">OPK : </span><span className="font-mono">{diag?.opkCount ?? '…'}</span></div>
                        <div><span className="text-muted-foreground">Windows Hello : </span>{diag ? diagnosticLine(diag.webauthnCount > 0, 'activé', 'non enregistré') : '…'}</div>
                        <div><span className="text-muted-foreground">Actif : </span>{diagnosticLine(device.isActive && !device.revokedAt, 'oui', 'non')}</div>
                      </div>

                      {(diag?.routingError || diag?.error) && (
                        <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 p-2">
                          <p className="font-semibold text-destructive">Problème détecté</p>
                          {diag.routingError && <p className="mt-1 break-all font-mono text-[11px]">{diag.routingError}</p>}
                          {diag.error && <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">Diagnostic: {diag.error}</p>}
                        </div>
                      )}

                      {isCurrent && (
                        <IosDeviceDiagnosticsSection
                          userId={user?.id ?? null}
                          deviceId={device.deviceId}
                          server={{
                            bindingStatus: device.bindingStatus,
                            routingStatus: device.routingStatus,
                            routingError: diag?.routingError ?? null,
                            spkCount: diag?.spkCount ?? null,
                            opkCount: diag?.opkCount ?? null,
                          }}
                        />
                      )}

                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" className="h-8" onClick={() => void load(true)} disabled={refreshing}>
                          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                          Actualiser
                        </Button>
                        <Button size="sm" variant="outline" className="h-8" onClick={() => void copyDiagnostic(device)}>
                          <Copy className="mr-1.5 h-3.5 w-3.5" />
                          Copier le rapport
                        </Button>
                      </div>
                    </div>
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
