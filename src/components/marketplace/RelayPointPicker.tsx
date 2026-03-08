import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { MapPin, Search, Clock, Loader2, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface RelayPoint {
  id: string;
  name: string;
  address: string;
  postcode: string;
  city: string;
  country: string;
  latitude: string;
  longitude: string;
  distance: string;
  hours_monday: string;
  hours_tuesday: string;
  hours_wednesday: string;
  hours_thursday: string;
  hours_friday: string;
  hours_saturday: string;
  hours_sunday: string;
}

interface RelayPointPickerProps {
  onSelect: (point: RelayPoint) => void;
  selectedId?: string;
  country?: string;
}

function formatHours(raw: string) {
  if (!raw || raw === '0000 0000 0000 0000') return 'Fermé';
  const parts = raw.trim().split(/\s+/);
  const slots: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i] && parts[i] !== '0000' && parts[i + 1] && parts[i + 1] !== '0000') {
      slots.push(`${parts[i].substring(0, 2)}h${parts[i].substring(2)}-${parts[i + 1].substring(0, 2)}h${parts[i + 1].substring(2)}`);
    }
  }
  return slots.length > 0 ? slots.join(', ') : 'Fermé';
}

export function RelayPointPicker({ onSelect, selectedId, country = 'FR' }: RelayPointPickerProps) {
  const [postcode, setPostcode] = useState('');
  const [points, setPoints] = useState<RelayPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const searchPoints = async () => {
    if (!postcode.trim()) return;
    setLoading(true);
    setError('');

    try {
      const { data, error: fnError } = await supabase.functions.invoke('mondial-relay', {
        body: { action: 'search_points', postcode: postcode.trim(), country },
      });

      if (fnError) throw fnError;
      if (data?.error) throw new Error(data.error);

      setPoints(data.points || []);
      if (data.points?.length === 0) setError('Aucun point relais trouvé');
    } catch (e: any) {
      setError(e.message || 'Erreur de recherche');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={postcode}
            onChange={(e) => setPostcode(e.target.value)}
            placeholder="Code postal"
            className="pl-9"
            onKeyDown={(e) => e.key === 'Enter' && searchPoints()}
          />
        </div>
        <Button onClick={searchPoints} disabled={loading || !postcode.trim()} size="sm">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {points.length > 0 && (
        <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
          {points.map((point) => {
            const isSelected = selectedId === point.id;
            const isExpanded = expandedId === point.id;
            return (
              <Card
                key={point.id}
                className={cn(
                  'p-3 cursor-pointer transition-all border-2',
                  isSelected
                    ? 'border-primary bg-primary/5 shadow-[0_0_12px_hsl(var(--primary)/0.15)]'
                    : 'border-transparent hover:border-primary/30 hover:bg-accent/50'
                )}
                onClick={() => onSelect(point)}
              >
                <div className="flex items-start gap-2">
                  <div className={cn(
                    'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5',
                    isSelected ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
                  )}>
                    {isSelected ? <CheckCircle2 className="w-4 h-4" /> : <MapPin className="w-4 h-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{point.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{point.address}</p>
                    <p className="text-xs text-muted-foreground">{point.postcode} {point.city}</p>
                    {point.distance && (
                      <p className="text-[10px] text-primary font-medium mt-0.5">
                        à {(parseInt(point.distance) / 1000).toFixed(1)} km
                      </p>
                    )}

                    <button
                      onClick={(e) => { e.stopPropagation(); setExpandedId(isExpanded ? null : point.id); }}
                      className="text-[10px] text-primary hover:underline mt-1 flex items-center gap-1"
                    >
                      <Clock className="w-3 h-3" />
                      Horaires
                    </button>

                    {isExpanded && (
                      <div className="mt-2 text-[10px] text-muted-foreground space-y-0.5 bg-secondary/50 rounded-lg p-2">
                        <div className="flex justify-between"><span>Lun</span><span>{formatHours(point.hours_monday)}</span></div>
                        <div className="flex justify-between"><span>Mar</span><span>{formatHours(point.hours_tuesday)}</span></div>
                        <div className="flex justify-between"><span>Mer</span><span>{formatHours(point.hours_wednesday)}</span></div>
                        <div className="flex justify-between"><span>Jeu</span><span>{formatHours(point.hours_thursday)}</span></div>
                        <div className="flex justify-between"><span>Ven</span><span>{formatHours(point.hours_friday)}</span></div>
                        <div className="flex justify-between"><span>Sam</span><span>{formatHours(point.hours_saturday)}</span></div>
                        <div className="flex justify-between"><span>Dim</span><span>{formatHours(point.hours_sunday)}</span></div>
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
