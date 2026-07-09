import { Timer, Moon, Eye, TrendingDown, Clock, Coffee, Zap, Shield } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { DetoxSchedulePanel } from './DetoxSchedulePanel';
import { getTodayMinutes, getWeeklyUsage } from '@/lib/ml/feedAlgorithm';
import { useWellbeingPreferences } from '@/hooks/useWellbeingPreferences';

function formatMinutes(m: number) {
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    return min > 0 ? `${h}h ${min}min` : `${h}h`;
  }
  return `${m} min`;
}

export function WellbeingSettingsPanel() {
  const { t } = useTranslation();
  const { prefs, update } = useWellbeingPreferences();

  const todayMinutes = getTodayMinutes();
  const weekData = getWeeklyUsage();
  const weekAvg = Math.round(weekData.reduce((a, b) => a + b, 0) / weekData.length);
  const maxWeek = Math.max(1, ...weekData);

  const usagePercent = Math.min(100, Math.round((todayMinutes / prefs.dailyLimitMinutes) * 100));
  const daysOfWeek = [
    t('wellbeing.mon'), t('wellbeing.tue'), t('wellbeing.wed'), t('wellbeing.thu'),
    t('wellbeing.fri'), t('wellbeing.sat'), t('wellbeing.sun'),
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Clock className="w-3.5 h-3.5" />
          {t('wellbeing.today')}
        </h3>
        <div className="p-4 rounded-xl bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/20">
          <div className="flex items-end justify-between mb-3">
            <div>
              <p className="text-2xl font-bold">{formatMinutes(todayMinutes)}</p>
              <p className="text-[11px] text-muted-foreground">{t('wellbeing.of')} {formatMinutes(prefs.dailyLimitMinutes)} {t('wellbeing.allowed')}</p>
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

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <TrendingDown className="w-3.5 h-3.5" />
          {t('wellbeing.thisWeek')} — {t('wellbeing.avg')} {formatMinutes(weekAvg)}{t('wellbeing.avgPerDay')}
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

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Timer className="w-3.5 h-3.5" />
          {t('wellbeing.dailyLimit')}
        </h3>
        <div className="px-1">
          <Slider value={[prefs.dailyLimitMinutes]} onValueChange={([v]) => update({ dailyLimitMinutes: v })} min={15} max={180} step={15} />
          <div className="flex justify-between mt-1.5">
            <span className="text-[10px] text-muted-foreground">15 {t('wellbeing.min')}</span>
            <span className="text-xs font-semibold text-primary">{formatMinutes(prefs.dailyLimitMinutes)}</span>
            <span className="text-[10px] text-muted-foreground">3h</span>
          </div>
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div className="flex items-start gap-3">
            <Coffee className="w-4 h-4 text-primary mt-0.5" />
            <div>
              <Label className="text-sm font-medium">{t('wellbeing.scrollPause')}</Label>
              <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                {t('wellbeing.scrollPauseDesc')} {prefs.scrollPauseMinutes} {t('wellbeing.min')}
              </p>
            </div>
          </div>
          <Switch checked={prefs.scrollPauseEnabled} onCheckedChange={v => update({ scrollPauseEnabled: v })} />
        </div>

        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div className="flex items-start gap-3">
            <Moon className="w-4 h-4 text-primary mt-0.5" />
            <div>
              <Label className="text-sm font-medium">{t('wellbeing.bedtimeReminder')}</Label>
              <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                {t('wellbeing.bedtimeDesc')} {prefs.bedtimeHour}h {t('wellbeing.bedtimeDescSuffix')}
              </p>
            </div>
          </div>
          <Switch checked={prefs.bedtimeReminderEnabled} onCheckedChange={v => update({ bedtimeReminderEnabled: v })} />
        </div>

        {prefs.bedtimeReminderEnabled && (
          <div className="px-10 pb-2">
            <Slider value={[prefs.bedtimeHour]} onValueChange={([v]) => update({ bedtimeHour: v })} min={20} max={2} step={1} />
            <p className="text-[10px] text-center text-muted-foreground mt-1">
              {t('wellbeing.hour')} : {prefs.bedtimeHour}h00
            </p>
          </div>
        )}

        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div className="flex items-start gap-3">
            <Zap className="w-4 h-4 text-primary mt-0.5" />
            <div>
              <Label className="text-sm font-medium">{t('wellbeing.focusMode')}</Label>
              <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t('wellbeing.focusDesc')}</p>
            </div>
          </div>
          <Switch checked={prefs.focusModeEnabled} onCheckedChange={v => update({ focusModeEnabled: v })} />
        </div>

        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div className="flex items-start gap-3">
            <Eye className="w-4 h-4 text-primary mt-0.5" />
            <div>
              <Label className="text-sm font-medium">{t('wellbeing.hideCounts')}</Label>
              <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t('wellbeing.hideCountsDesc')}</p>
            </div>
          </div>
          <Switch checked={prefs.hideLikeCounts} onCheckedChange={v => update({ hideLikeCounts: v })} />
        </div>

        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div className="flex items-start gap-3">
            <TrendingDown className="w-4 h-4 text-primary mt-0.5" />
            <div>
              <Label className="text-sm font-medium">{t('wellbeing.grayscale')}</Label>
              <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t('wellbeing.grayscaleDesc')}</p>
            </div>
          </div>
          <Switch checked={prefs.grayscaleAfterLimit} onCheckedChange={v => update({ grayscaleAfterLimit: v })} />
        </div>
      </div>

      {/* Detox Schedule */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Shield className="w-3.5 h-3.5" />
          Détox digitale programmée
        </h3>
        <DetoxSchedulePanel />
      </div>
    </div>
  );
}
