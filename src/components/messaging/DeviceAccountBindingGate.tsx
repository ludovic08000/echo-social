import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { useDeviceLifecycle } from '@/hooks/useDeviceLifecycle';
import { deviceSecurity } from '@/lib/device-manager/deviceSecurity';
import { cn } from '@/lib/utils';

interface DeviceAccountBindingGateProps {
  children: ReactNode;
  compact?: boolean;
}

export function DeviceAccountBindingGate({ children, compact = false }: DeviceAccountBindingGateProps) {
  const { user } = useAuth();
  const lifecycle = useDeviceLifecycle();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attemptedRef = useRef<string | null>(null);

  const bound = lifecycle.record?.bindingStatus === 'bound';
  const canBind = Boolean(
    user?.id
    && lifecycle.deviceId
    && lifecycle.pinUnlocked
    && lifecycle.record?.approvalStatus === 'approved'
    && lifecycle.record?.isActive === true
    && !lifecycle.record?.revokedAt,
  );

  const bind = useCallback(async () => {
    if (!user?.id || !lifecycle.deviceId || !canBind || processing || bound) return;
    setProcessing(true);
    setError(null);
    try {
      const record = await deviceSecurity.bind(user.id);
      attemptedRef.current = null;
      lifecycle.refresh();
      window.dispatchEvent(new CustomEvent('forsure:device-account-bound', {
        detail: { deviceId: record.deviceId, source: 'deviceSecurity.bind' },
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'DEVICE_ACCOUNT_BIND_FAILED');
    } finally {
      setProcessing(false);
    }
  }, [bound, canBind, lifecycle, processing, user?.id]);

  useEffect(() => {
    if (!canBind || bound || !lifecycle.deviceId) return;
    if (attemptedRef.current === lifecycle.deviceId) return;
    attemptedRef.current = lifecycle.deviceId;
    void bind();
  }, [bind, bound, canBind, lifecycle.deviceId]);

  if (bound) return <>{children}</>;

  return (
    <div className={cn(
      'flex h-full items-center justify-center overflow-y-auto bg-background',
      compact ? 'px-3 py-4' : 'min-h-[50vh] px-4 py-8',
    )}>
      <div className={cn('w-full text-center', compact ? 'max-w-full' : 'max-w-sm')}>
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
          {processing ? <Loader2 className="h-5 w-5 animate-spin text-primary" /> : <ShieldCheck className="h-5 w-5 text-primary" />}
        </div>
        <h2 className="text-sm font-bold">Finalisation de cet appareil</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          L’appareil a été approuvé. Echo Social lie maintenant sa clé cryptographique à votre identité de compte avant d’activer la messagerie.
        </p>
        {error && (
          <div className="mt-3">
            <p className="mb-2 text-xs text-destructive">{error}</p>
            <Button size="sm" variant="outline" onClick={() => { attemptedRef.current = null; void bind(); }}>
              Réessayer
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
