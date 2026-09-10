import { useEffect, useState } from 'react';
import { Copy, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DEVICE_FINALIZATION_TRACE_EVENT,
  getDeviceFinalizationTrace,
  type DeviceFinalizationTraceEvent,
} from '@/lib/device-manager/deviceFinalizationTrace';

const VISIBLE_EVENTS = 20;

/**
 * Diagnostic de finalisation appareil.
 *
 * Invariant : le tampon de trace est déjà assaini (identifiants masqués, codes
 * d'erreur normalisés). Ce composant n'affiche jamais autre chose que ces
 * événements : ni PIN, ni jeton, ni clé, ni message serveur brut.
 */
export function DeviceFinalizationDiagnostics({ open: initialOpen = false }: { open?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [events, setEvents] = useState<DeviceFinalizationTraceEvent[]>(() => getDeviceFinalizationTrace(VISIBLE_EVENTS));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const refresh = () => setEvents(getDeviceFinalizationTrace(VISIBLE_EVENTS));
    refresh();
    window.addEventListener(DEVICE_FINALIZATION_TRACE_EVENT, refresh as EventListener);
    return () => window.removeEventListener(DEVICE_FINALIZATION_TRACE_EVENT, refresh as EventListener);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(events, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="mt-3 w-full rounded-xl border border-border/60 bg-muted/40 px-3 py-2 text-left">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-xs font-semibold"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Diagnostic de finalisation
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <div className="max-h-48 overflow-auto rounded-lg bg-background/70 p-2 font-mono text-[10px] leading-relaxed">
            {events.length === 0 ? (
              <p className="text-muted-foreground">Aucun événement de finalisation enregistré.</p>
            ) : (
              events.map((event) => (
                <div key={`${event.traceId}-${event.seq}`} className="break-all">
                  {`${event.at} ${event.step} ${event.outcome}`}
                  {typeof event.elapsedMs === 'number' ? ` ${event.elapsedMs}ms` : ''}
                  {event.attempt ? ` try:${event.attempt}` : ''}
                  {event.errorCode ? ` ${event.errorCode}` : ''}
                  {event.detail ? ` ${event.detail}` : ''}
                  {event.state
                    ? ` [${event.state.approvalStatus ?? '-'}/${event.state.bindingStatus ?? '-'}/${event.state.routingStatus ?? '-'}/${event.state.lifecycleStatus ?? '-'}]`
                    : ''}
                </div>
              ))
            )}
          </div>
          <Button size="sm" variant="outline" className="w-full rounded-lg" onClick={() => void copy()}>
            <Copy className="mr-2 h-3.5 w-3.5" />
            {copied ? 'Diagnostic copié' : 'Copier le diagnostic'}
          </Button>
        </div>
      )}
    </div>
  );
}
