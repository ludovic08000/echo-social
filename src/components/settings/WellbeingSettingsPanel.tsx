import { useState, useEffect, useMemo } from 'react';
import { Timer, Moon, Eye, TrendingDown, Clock, Coffee, Zap } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

interface WellbeingPrefs {
  dailyLimitMinutes: number;
  focusModeEnabled: boolean;
  bedtimeReminderEnabled: boolean;
  bedtimeHour: number;
  scrollPauseEnabled: boolean;
  scrollPauseMinutes: number;
  hideLikeCounts: boolean;
  grayscaleAfterLimit: boolean;
}

const defaultPrefs: WellbeingPrefs = {
  dailyLimitMinutes: 60,
  focusModeEnabled: false,
  bedtimeReminderEnabled: false,
  bedtimeHour: 23,
  scrollPauseEnabled: true,
  scrollPauseMinutes: 15,
  hideLikeCounts: false,
  grayscaleAfterLimit: false,
};

function formatMinutes(m: number) {
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    return min > 0 ? `${h}h ${min}min` : `${h}h`;
  }
  return `${m} min`;
}

export function WellbeingSettingsPanel() {
  const [prefs, setPrefs] = useState<WellbeingPrefs>(() => {
    try {
      const saved = localStorage.getItem('wellbeing-prefs');
      return saved ? { ...defaultPrefs, ...JSON.parse(saved) } : defaultPrefs;
    } catch {
      return defaultPrefs;
    }
  });

  // Simulated usage data
  const todayMinutes = useMemo(() => Math.floor(Math.random() * 45) + 10, []);
  const weekData = useMemo(() => [28, 45, 32, 52, 18, 40, todayMinutes], [todayMinutes]);
  const weekAvg = Math.round(weekData.reduce((a, b) => a + b, 0) / weekData.length);
  const maxWeek = Math.max(...weekData);

  useEffect(() => {
    localStorage.setItem('wellbeing-prefs', JSON.stringify(prefs));
  }, [prefs]);

  const update = (patch: Partial<WellbeingPrefs>) => {
    setPrefs(prev => ({ ...prev, ...patch }));
  };

  const usagePercent = Math.min(100, Math.round((todayMinutes / prefs.dailyLimitMinutes) * 100));
  const daysOfWeek = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

  return (
    <div className="space-y-6">
      {/* Today's usage */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Clock className="w-3.5 h-3.5" />
          Aujourd'hui
        </h3>
        <div className="p-4 rounded-xl bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/20">
          <div className="flex items-end justify-between mb-3">
            <div>
              <p className="text-2xl font-bold">{formatMinutes(todayMinutes)}</p>
              <p className="text-[11px] text-muted-foreground">sur {formatMinutes(prefs.dailyLimitMinutes)} autorisés</p>
            </div>
          <div className={cn(
              "text-xs font-semibold px-2.5 py-1 rounded-full",
              usagePercent < 50 ? "bg-primary/15 text-primary" :
              usagePercent < 80 ? "bg-accent text-accent-foreground" :
              "bg-destructive/15 text-destructive"
            )}>
              {usagePercent}%
            </div>
          </div>
          <Progress value={usagePercent} className="h-2 rounded-full" />
        </div>
      </div>

      {/* Weekly chart */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <TrendingDown className="w-3.5 h-3.5" />
          Cette semaine — Moy. {formatMinutes(weekAvg)}/jour
        </h3>
        <div className="flex items-end justify-between gap-1.5 h-24 px-2">
          {weekData.map((min, i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <div className="w-full flex flex-col justify-end" style={{ height: '72px' }}>
                <div
                  className={cn(
                    "w-full rounded-t-md transition-all duration-300",
                    i === weekData.length - 1 ? "bg-primary" : "bg-primary/30"
                  )}
                  style={{ height: `${Math.max(4, (min / maxWeek) * 72)}px` }}
                />
              </div>
              <span className="text-[9px] text-muted-foreground font-medium">{daysOfWeek[i]}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Daily limit */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Timer className="w-3.5 h-3.5" />
          Limite quotidienne
        </h3>
        <div className="px-1">
          <Slider
            value={[prefs.dailyLimitMinutes]}
            onValueChange={([v]) => update({ dailyLimitMinutes: v })}
            min={15}
            max={180}
            step={15}
          />
          <div className="flex justify-between mt-1.5">
            <span className="text-[10px] text-muted-foreground">15 min</span>
            <span className="text-xs font-semibold text-primary">{formatMinutes(prefs.dailyLimitMinutes)}</span>
            <span className="text-[10px] text-muted-foreground">3h</span>
          </div>
        </div>
      </div>

      {/* Features */}
      <div className="space-y-1">
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div className="flex items-start gap-3">
            <Coffee className="w-4 h-4 text-primary mt-0.5" />
            <div>
              <Label className="text-sm font-medium">Pause de défilement</Label>
              <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                Rappel de faire une pause toutes les {prefs.scrollPauseMinutes} min
              </p>
            </div>
          </div>
          <Switch checked={prefs.scrollPauseEnabled} onCheckedChange={v => update({ scrollPauseEnabled: v })} />
        </div>

        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div className="flex items-start gap-3">
            <Moon className="w-4 h-4 text-primary mt-0.5" />
            <div>
              <Label className="text-sm font-medium">Rappel coucher</Label>
              <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                Notification à {prefs.bedtimeHour}h pour arrêter
              </p>
            </div>
          </div>
          <Switch checked={prefs.bedtimeReminderEnabled} onCheckedChange={v => update({ bedtimeReminderEnabled: v })} />
        </div>

        {prefs.bedtimeReminderEnabled && (
          <div className="px-10 pb-2">
            <Slider
              value={[prefs.bedtimeHour]}
              onValueChange={([v]) => update({ bedtimeHour: v })}
              min={20}
              max={2}
              step={1}
            />
            <p className="text-[10px] text-center text-muted-foreground mt-1">
              Heure : {prefs.bedtimeHour}h00
            </p>
          </div>
        )}

        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div className="flex items-start gap-3">
            <Zap className="w-4 h-4 text-primary mt-0.5" />
            <div>
              <Label className="text-sm font-medium">Mode focus</Label>
              <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                Masque les notifications et le fil pendant 25 min
              </p>
            </div>
          </div>
          <Switch checked={prefs.focusModeEnabled} onCheckedChange={v => update({ focusModeEnabled: v })} />
        </div>

        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div className="flex items-start gap-3">
            <Eye className="w-4 h-4 text-primary mt-0.5" />
            <div>
              <Label className="text-sm font-medium">Masquer les compteurs</Label>
              <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                Cacher le nombre de likes et réactions
              </p>
            </div>
          </div>
          <Switch checked={prefs.hideLikeCounts} onCheckedChange={v => update({ hideLikeCounts: v })} />
        </div>

        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div className="flex items-start gap-3">
            <TrendingDown className="w-4 h-4 text-primary mt-0.5" />
            <div>
              <Label className="text-sm font-medium">Écran gris après limite</Label>
              <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                L'app passe en niveaux de gris après la limite
              </p>
            </div>
          </div>
          <Switch checked={prefs.grayscaleAfterLimit} onCheckedChange={v => update({ grayscaleAfterLimit: v })} />
        </div>
      </div>
    </div>
  );
}
