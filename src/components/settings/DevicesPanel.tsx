/**
 * DevicesPanel — lists every active device tied to the logged-in user and
 * lets them revoke any device that isn't the current one. Revocation:
 *   1) sets `is_active = false` on `user_devices` (RLS ensures the user can
 *      only touch their own rows) so the device stops showing up in fan-out
 *      and X3DH bundle lookups,
 *   2) deletes the local device-pair sessions on the current device so
 *      future messages re-handshake cleanly.
 */
import { useEffect, useMemo, useState } from 'react';
import { Loader2, Smartphone, Monitor, Tablet, ShieldOff, BadgeCheck, Trash2, AlertTriangle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { getCurrentDeviceId } from '@/lib/messaging/currentDevice';
import { invalidateDeviceSession } from '@/lib/crypto/deviceRatchet';
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
  platform: string | null;
  user_agent: string | null;
  last_seen_at: string;
  created_at: string;
  is_active: boolean;
  stale_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

function platformIcon(platform: string | null, ua: string | null) {
  const hint = `${platform ?? ''} ${ua ?? ''}`.toLowerCase();
  if (hint.includes('ipad') || hint.includes('tablet')) return Tablet;
  if (hint.includes('iphone') || hint.includes('android') || hint.includes('mobile')) return Smartphone;
  return Monitor;
}

export function DevicesPanel() {
  const { user } = useAuth();
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const currentDeviceId = useMemo(() => getCurrentDeviceId(), []);

  const load = async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await (supabase as any)
      .from('user_devices')
      .select('id, device_id, device_name, platform, user_agent, last_seen_at, created_at, is_active, stale_at, revoked_at, revoke_reason')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .order('last_seen_at', { ascending: false });
    if (error) {
      toast.error('Impossible de charger les appareils');
    } else {
      setDevices((data ?? []) as DeviceRow[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const handleRevoke = async (dev: DeviceRow) => {
    if (!user) return;
    if (dev.device_id === currentDeviceId) {
      toast.error('Vous ne pouvez pas révoquer l\'appareil actuel');
      return;
    }
    setRevoking(dev.device_id);
    try {
      const { error } = await supabase
        .from('user_devices')
        .update({
          is_active: false,
          revoked_at: new Date().toISOString(),
          revoke_reason: 'manual',
        } as any)
        .eq('user_id', user.id)
        .eq('device_id', dev.device_id);
      if (error) throw error;

      // Drop our local cached session for this peer (self → other own device)
      // so we re-handshake on the next outbound message — defence in depth.
      try {
        await invalidateDeviceSession(user.id, currentDeviceId, user.id, dev.device_id);
      } catch {
        // non-fatal
      }

      toast.success('Appareil révoqué');
      setDevices(prev => prev.filter(d => d.device_id !== dev.device_id));
    } catch (e: any) {
      toast.error(e?.message || 'Échec de la révocation');
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

  if (devices.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-6 text-center">
        Aucun appareil actif détecté.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground leading-relaxed">
        Voici tous les appareils connectés à votre compte. Révoquez immédiatement tout appareil inconnu
        — il perdra l'accès à la messagerie chiffrée.
      </p>

      <ul className="space-y-2">
        {devices.map((dev) => {
          const Icon = platformIcon(dev.platform, dev.user_agent);
          const isCurrent = dev.device_id === currentDeviceId;
          const isStale = !!dev.stale_at;
          const lastSeen = formatDistanceToNow(new Date(dev.last_seen_at), {
            addSuffix: true,
            locale: fr,
          });
          const label =
            dev.device_name ||
            dev.platform ||
            (dev.user_agent ? dev.user_agent.split(' ')[0] : 'Appareil inconnu');

          return (
            <li
              key={dev.device_id}
              className={cn(
                'flex items-start gap-3 p-3.5 rounded-2xl border bg-card',
                isCurrent ? 'border-primary/40 bg-primary/5' : 'border-border/40',
              )}
            >
              <div
                className={cn(
                  'flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center',
                  isCurrent ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                )}
              >
                <Icon className="w-5 h-5" />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold truncate">{label}</span>
                  {isCurrent && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-primary bg-primary/10 px-1.5 py-0.5 rounded-md">
                      <BadgeCheck className="w-3 h-3" />
                      Actuel
                    </span>
                  )}
                  {isStale && !isCurrent && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-500/10 px-1.5 py-0.5 rounded-md">
                      <AlertTriangle className="w-3 h-3" />
                      Inactif
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Dernière activité {lastSeen}
                </p>
                {dev.platform && (
                  <p className="text-[11px] text-muted-foreground/70 mt-0.5 truncate">
                    {dev.platform}
                  </p>
                )}
              </div>

              {!isCurrent && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 text-destructive hover:text-destructive hover:bg-destructive/10 rounded-xl"
                      disabled={revoking === dev.device_id}
                    >
                      {revoking === dev.device_id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle className="flex items-center gap-2">
                        <ShieldOff className="w-5 h-5 text-destructive" />
                        Révoquer cet appareil ?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        L'appareil <strong>{label}</strong> ne pourra plus déchiffrer les nouveaux
                        messages reçus. Cette action est immédiate.
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
    </div>
  );
}
