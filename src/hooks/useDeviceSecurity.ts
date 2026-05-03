import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

/** Build a stable raw fingerprint string for this device (hashed server-side as SHA-256). */
function buildRawFingerprint(): string {
  const parts = [
    navigator.userAgent,
    `${screen.width}x${screen.height}`,
    `${screen.colorDepth}`,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    navigator.language,
    navigator.languages?.join(',') ?? '',
    navigator.hardwareConcurrency?.toString() ?? '?',
    (navigator as any).deviceMemory?.toString() ?? '?',
    (navigator as any).platform ?? '',
  ];
  return parts.join('||');
}

const STORAGE_KEY = 'forsure-device-registered';

export function useDeviceSecurity() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;
    const key = `${STORAGE_KEY}-${user.id}`;
    // Re-register at most once per 6h to refresh geo / detect changes
    const last = Number(localStorage.getItem(key) || 0);
    if (Date.now() - last < 6 * 60 * 60_000) return;

    const raw = buildRawFingerprint();
    const label = navigator.userAgent.match(/\(([^)]+)\)/)?.[1]?.split(';')[0]?.trim() || 'Appareil';

    supabase.functions.invoke('device-security', {
      body: { action: 'register', rawFingerprint: raw, deviceLabel: label },
    }).then(({ data }) => {
      if (data) localStorage.setItem(key, String(Date.now()));
    }).catch(() => {});
  }, [user]);
}
