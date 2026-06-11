import { useEffect, useState } from 'react';
import { ShieldCheck, MonitorSmartphone } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MessagingPinGate } from '@/components/MessagingPinGate';
import { useAuth } from '@/lib/auth';
import type { BrowserDeviceInfo, RiskLevel } from '@/lib/security/browserDeviceTrust';

interface DeviceTrustRequiredDetail {
  userId?: string;
  status?: string;
  riskLevel?: RiskLevel;
  reasons?: string[];
  device?: BrowserDeviceInfo;
  message?: string;
}

function reasonsToFrench(reasons: string[] = []): string {
  if (reasons.includes('unknown_device')) return 'Nouveau navigateur détecté.';
  if (reasons.includes('os_changed')) return 'Système d’exploitation différent détecté.';
  if (reasons.includes('browser_changed')) return 'Navigateur différent détecté.';
  if (reasons.includes('country_changed')) return 'Localisation inhabituelle détectée.';
  if (reasons.includes('timezone_changed')) return 'Fuseau horaire différent détecté.';
  if (reasons.includes('device_not_trusted')) return 'Ce navigateur n’est pas encore autorisé.';
  return 'Vérification de sécurité requise.';
}

export function E2EEDeviceTrustModal() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [request, setRequest] = useState<DeviceTrustRequiredDetail | null>(null);

  useEffect(() => {
    if (!userId) {
      setRequest(null);
      return;
    }

    const onRequired = (event: Event) => {
      const detail = (event as CustomEvent<DeviceTrustRequiredDetail>).detail ?? {};
      if (detail.userId && detail.userId !== userId) return;
      setRequest(detail);
    };

    const onTrusted = () => setRequest(null);

    window.addEventListener('forsure:e2ee-device-trust-required', onRequired);
    window.addEventListener('forsure:e2ee-device-trusted', onTrusted);
    window.addEventListener('forsure:e2ee-resync-complete', onTrusted);

    return () => {
      window.removeEventListener('forsure:e2ee-device-trust-required', onRequired);
      window.removeEventListener('forsure:e2ee-device-trusted', onTrusted);
      window.removeEventListener('forsure:e2ee-resync-complete', onTrusted);
    };
  }, [userId]);

  if (!userId) return null;

  const device = request?.device;
  const description = reasonsToFrench(request?.reasons);

  return (
    <Dialog open={!!request} onOpenChange={(open) => { if (!open) setRequest(null); }}>
      <DialogContent className="max-w-sm rounded-2xl p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-2 text-center">
          <div className="mx-auto mb-3 h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center">
            <MonitorSmartphone className="h-6 w-6 text-primary" />
          </div>
          <DialogTitle className="text-base leading-snug">
            Nouveau device à valider
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            {description} Entrez votre PIN pour autoriser ce navigateur avant l’envoi ou la synchronisation E2EE.
          </DialogDescription>
        </DialogHeader>

        {device && (
          <div className="mx-5 mb-3 rounded-xl border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
            <div><span className="font-medium text-foreground">Navigateur :</span> {device.browserName} {device.browserVersion}</div>
            <div><span className="font-medium text-foreground">Système :</span> {device.osName} {device.osVersion}</div>
            <div><span className="font-medium text-foreground">Fuseau :</span> {device.timezone}</div>
            {(device.city || device.country) && (
              <div><span className="font-medium text-foreground">Lieu :</span> {[device.city, device.country].filter(Boolean).join(', ')}</div>
            )}
          </div>
        )}

        <div className="px-3 pb-4">
          <MessagingPinGate compact>
            <div className="flex items-center justify-center gap-2 rounded-xl border border-primary/15 bg-primary/5 px-3 py-4 text-xs font-medium text-primary">
              <ShieldCheck className="h-4 w-4" />
              Device autorisé après validation PIN
            </div>
          </MessagingPinGate>
        </div>
      </DialogContent>
    </Dialog>
  );
}
