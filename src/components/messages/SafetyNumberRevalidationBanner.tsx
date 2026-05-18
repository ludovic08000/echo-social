/**
 * Lot 4 — Safety Numbers revalidation banner.
 *
 * Floats above the app after a successful local E2EE restore so the user is
 * gently invited to re-verify Safety Numbers with their important contacts.
 *
 * Listens to `forsure:e2ee-post-restore` (emitted by postRestoreSync after
 * any restore: recovery_key, pin_backup, password_active_session, in-memory
 * Master Key). Auto-dismisses after 20s; the user can also dismiss it.
 */

import { useEffect, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Reason = string;

export function SafetyNumberRevalidationBanner() {
  const [visible, setVisible] = useState(false);
  const [reason, setReason] = useState<Reason>('manual');
  const navigate = useNavigate();

  useEffect(() => {
    const onRestore = (e: Event) => {
      const detail = (e as CustomEvent).detail as { reason?: string } | undefined;
      setReason(detail?.reason ?? 'manual');
      setVisible(true);
      const t = window.setTimeout(() => setVisible(false), 20_000);
      return () => window.clearTimeout(t);
    };
    window.addEventListener('forsure:e2ee-post-restore', onRestore);
    return () => window.removeEventListener('forsure:e2ee-post-restore', onRestore);
  }, []);

  if (!visible) return null;

  const labelByReason: Record<string, string> = {
    recovery_key: 'depuis votre clé de récupération',
    pin_backup: 'depuis votre PIN de secours',
    password_active_session: 'depuis votre session active',
    in_memory_master_key: 'depuis votre clé maîtresse',
    manual: '',
  };

  return (
    <div
      className={cn(
        'fixed inset-x-0 top-2 z-[60] mx-auto max-w-md px-3',
        'pointer-events-none',
      )}
      role="status"
    >
      <div
        className={cn(
          'pointer-events-auto rounded-2xl border border-sky-500/30 bg-sky-500/10',
          'px-3 py-2.5 text-sm text-sky-100 shadow-lg backdrop-blur-xl',
          'flex items-start gap-2',
        )}
      >
        <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-sky-300" aria-hidden />
        <div className="flex-1 min-w-0">
          <div className="font-medium">Vos clés ont été restaurées</div>
          <div className="text-xs opacity-80">
            Re-vérifiez vos numéros de sécurité avec vos contacts importants
            {labelByReason[reason] ? ` (${labelByReason[reason]})` : ''}.
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-sky-100 hover:bg-sky-500/20"
            onClick={() => {
              setVisible(false);
              navigate('/messages');
            }}
          >
            Vérifier
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-sky-100 hover:bg-sky-500/20"
            onClick={() => setVisible(false)}
            aria-label="Fermer"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
