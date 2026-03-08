import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Package, Truck, MapPin, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TrackingEvent {
  date: string;
  status: string;
  location: string;
}

interface OrderTrackingProps {
  trackingNumber: string;
}

export function OrderTracking({ trackingNumber }: OrderTrackingProps) {
  const [events, setEvents] = useState<TrackingEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchTracking = async () => {
    setLoading(true);
    setError('');
    try {
      const { data, error: fnError } = await supabase.functions.invoke('mondial-relay', {
        body: { action: 'track', tracking_number: trackingNumber },
      });

      if (fnError) throw fnError;
      if (data?.error) throw new Error(data.error);

      setEvents(data.events || []);
    } catch (e: any) {
      setError(e.message || 'Erreur de suivi');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (trackingNumber) fetchTracking();
  }, [trackingNumber]);

  const getIcon = (index: number) => {
    if (index === 0) return <CheckCircle2 className="w-4 h-4" />;
    if (index === events.length - 1) return <Package className="w-4 h-4" />;
    return <Truck className="w-4 h-4" />;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <Truck className="w-4 h-4 text-primary" />
          <span className="font-medium">Suivi : {trackingNumber}</span>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={fetchTracking} disabled={loading}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {events.length > 0 && (
        <div className="space-y-0">
          {events.map((event, i) => (
            <div key={i} className="flex gap-3 relative">
              {/* Timeline line */}
              {i < events.length - 1 && (
                <div className="absolute left-[15px] top-8 w-0.5 h-[calc(100%-8px)] bg-border" />
              )}
              <div className={cn(
                'w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 z-10',
                i === 0 ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
              )}>
                {getIcon(i)}
              </div>
              <div className="pb-4 flex-1">
                <p className="text-sm font-medium">{event.status}</p>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
                  {event.location && (
                    <span className="flex items-center gap-0.5">
                      <MapPin className="w-3 h-3" />
                      {event.location}
                    </span>
                  )}
                  <span>{event.date}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && events.length === 0 && !error && (
        <p className="text-xs text-muted-foreground text-center py-4">Aucune information de suivi disponible</p>
      )}
    </div>
  );
}
