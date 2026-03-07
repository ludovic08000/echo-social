import { useState } from 'react';
import { Target, Globe } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  COUNTRIES, ENABLED_COUNTRIES, POPULATION_FILTERS,
  getRegions, getCities,
  type TargetLocation,
} from '@/lib/geoData';

interface LocationSelectorProps {
  value: TargetLocation;
  onChange: (location: TargetLocation) => void;
  compact?: boolean;
}

export function LocationSelector({ value, onChange, compact }: LocationSelectorProps) {
  const [popFilter, setPopFilter] = useState(0);
  const [search, setSearch] = useState('');

  const regions = getRegions(value.country);
  const cities = value.region ? getCities(value.country, value.region, popFilter, search) : [];
  const showComingSoon = COUNTRIES.filter(c => !c.enabled).length > 0;

  const setCountry = (code: string) => onChange({ country: code, region: null, villes: [] });
  const setRegion = (r: string | null) => { onChange({ ...value, region: r, villes: [] }); setSearch(''); };
  const toggleVille = (nom: string) => {
    onChange({
      ...value,
      villes: value.villes.includes(nom) ? value.villes.filter(n => n !== nom) : [...value.villes, nom],
    });
  };

  return (
    <div className="space-y-3">
      <label className={cn("font-medium text-foreground flex items-center gap-2", compact ? "text-xs" : "text-sm")}>
        <Target className="w-4 h-4 text-primary" /> Zone géographique
      </label>

      {/* Country selector */}
      <div>
        <label className="text-[11px] font-medium text-muted-foreground mb-1.5 block flex items-center gap-1">
          <Globe className="w-3 h-3" /> Pays
        </label>
        <div className="flex flex-wrap gap-1.5">
          {ENABLED_COUNTRIES.map(c => (
            <button key={c.code} onClick={() => setCountry(c.code)}
              className={cn("px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all border",
                value.country === c.code ? "bg-primary/10 text-primary border-primary/30" : "bg-card text-muted-foreground border-border/30"
              )}>
              {c.flag} {c.label}
            </button>
          ))}
          {showComingSoon && (
            <span className="px-2.5 py-1 rounded-lg text-[10px] text-muted-foreground/50 border border-dashed border-border/20 italic">
              🇪🇺 Europe — bientôt
            </span>
          )}
        </div>
      </div>

      {/* Region selector */}
      <div>
        <label className="text-[11px] font-medium text-muted-foreground mb-1.5 block">Région</label>
        <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
          <button onClick={() => setRegion(null)}
            className={cn("px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all border",
              !value.region ? "bg-primary/10 text-primary border-primary/30" : "bg-card text-muted-foreground border-border/30"
            )}>
            {COUNTRIES.find(c => c.code === value.country)?.flag} Tout le pays
          </button>
          {regions.map(r => (
            <button key={r} onClick={() => setRegion(r)}
              className={cn("px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all border",
                value.region === r ? "bg-primary/10 text-primary border-primary/30" : "bg-card text-muted-foreground border-border/30"
              )}>
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Cities in selected region */}
      {value.region && (
        <div className="space-y-2">
          <label className="text-[11px] font-medium text-muted-foreground block">Villes — {value.region}</label>
          <div className="flex gap-1.5 flex-wrap">
            {POPULATION_FILTERS.map((f, i) => (
              <button key={i} onClick={() => setPopFilter(i)}
                className={cn("px-2 py-0.5 rounded-lg text-[10px] font-medium border transition-all",
                  popFilter === i ? "bg-primary/10 text-primary border-primary/30" : "bg-secondary/30 text-muted-foreground border-border/30"
                )}>
                {f.label} hab.
              </button>
            ))}
          </div>
          <Input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher une ville..." className="rounded-xl text-sm h-9" />
          <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
            {cities.map(v => (
              <button key={v.nom} onClick={() => toggleVille(v.nom)}
                className={cn("px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all border",
                  value.villes.includes(v.nom) ? "bg-primary/10 text-primary border-primary/30" : "bg-card text-muted-foreground border-border/30"
                )}>
                {v.nom} <span className="text-muted-foreground/60 ml-0.5">({(v.population / 1000).toFixed(0)}k)</span>
              </button>
            ))}
          </div>
          {value.villes.length > 0 && (
            <p className="text-[10px] text-primary font-medium">{value.villes.length} ville(s) sélectionnée(s)</p>
          )}
        </div>
      )}
    </div>
  );
}
