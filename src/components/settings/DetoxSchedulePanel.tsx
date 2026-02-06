import { useState, useEffect } from 'react';
import { Shield, Clock, Calendar, Zap } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { usePrivacySettings, useUpdatePrivacySettings } from '@/hooks/usePrivacySettings';
import { toast } from '@/hooks/use-toast';

interface DetoxSchedule {
  enabled: boolean;
  days: string[];
  startHour: number;
  endHour: number;
  streakDays: number;
}

const DAYS = [
  { key: 'mon', label: 'Lun' },
  { key: 'tue', label: 'Mar' },
  { key: 'wed', label: 'Mer' },
  { key: 'thu', label: 'Jeu' },
  { key: 'fri', label: 'Ven' },
  { key: 'sat', label: 'Sam' },
  { key: 'sun', label: 'Dim' },
];

const defaultSchedule: DetoxSchedule = {
  enabled: false,
  days: ['mon', 'wed', 'fri'],
  startHour: 21,
  endHour: 7,
  streakDays: 0,
};

export function DetoxSchedulePanel() {
  const { data: settings } = usePrivacySettings();
  const updateSettings = useUpdatePrivacySettings();

  const [schedule, setSchedule] = useState<DetoxSchedule>(defaultSchedule);

  useEffect(() => {
    if (settings?.detox_schedule) {
      setSchedule({ ...defaultSchedule, ...(settings.detox_schedule as any) });
    }
  }, [settings]);

  const save = async (updated: DetoxSchedule) => {
    setSchedule(updated);
    try {
      await updateSettings.mutateAsync({ detox_schedule: updated as any });
      toast({ title: 'Programme de détox mis à jour' });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const toggleDay = (day: string) => {
    const newDays = schedule.days.includes(day)
      ? schedule.days.filter(d => d !== day)
      : [...schedule.days, day];
    save({ ...schedule, days: newDays });
  };

  const isInDetoxNow = () => {
    if (!schedule.enabled) return false;
    const now = new Date();
    const currentDay = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()];
    if (!schedule.days.includes(currentDay)) return false;
    const hour = now.getHours();
    if (schedule.startHour > schedule.endHour) {
      return hour >= schedule.startHour || hour < schedule.endHour;
    }
    return hour >= schedule.startHour && hour < schedule.endHour;
  };

  return (
    <div className="space-y-5">
      {/* Status */}
      {schedule.enabled && (
        <div className={`p-4 rounded-xl border ${isInDetoxNow() ? 'bg-primary/10 border-primary/20' : 'bg-secondary/40 border-border/30'}`}>
          <div className="flex items-center gap-2">
            <Zap className={`w-4 h-4 ${isInDetoxNow() ? 'text-primary' : 'text-muted-foreground'}`} />
            <span className="text-sm font-medium">
              {isInDetoxNow() ? '🧘 Détox en cours' : 'Prochaine détox programmée'}
            </span>
          </div>
          {schedule.streakDays > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              🔥 {schedule.streakDays} jour{schedule.streakDays > 1 ? 's' : ''} de streak
            </p>
          )}
        </div>
      )}

      {/* Enable toggle */}
      <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
        <div className="flex items-start gap-3">
          <Shield className="w-4 h-4 text-primary mt-0.5" />
          <div>
            <Label className="text-sm font-medium">Détox digitale programmée</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">
              Bloquer l'app automatiquement aux horaires définis
            </p>
          </div>
        </div>
        <Switch
          checked={schedule.enabled}
          onCheckedChange={v => save({ ...schedule, enabled: v })}
        />
      </div>

      {schedule.enabled && (
        <>
          {/* Days selection */}
          <div>
            <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5" /> Jours de détox
            </p>
            <div className="flex gap-1.5">
              {DAYS.map(day => (
                <button
                  key={day.key}
                  onClick={() => toggleDay(day.key)}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
                    schedule.days.includes(day.key)
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary/60 text-muted-foreground hover:bg-secondary'
                  }`}
                >
                  {day.label}
                </button>
              ))}
            </div>
          </div>

          {/* Hours */}
          <div>
            <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" /> Plage horaire
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl bg-secondary/40">
                <label className="text-[10px] text-muted-foreground">Début</label>
                <select
                  value={schedule.startHour}
                  onChange={e => save({ ...schedule, startHour: parseInt(e.target.value) })}
                  className="w-full mt-1 bg-transparent text-sm font-medium"
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={i}>{i.toString().padStart(2, '0')}:00</option>
                  ))}
                </select>
              </div>
              <div className="p-3 rounded-xl bg-secondary/40">
                <label className="text-[10px] text-muted-foreground">Fin</label>
                <select
                  value={schedule.endHour}
                  onChange={e => save({ ...schedule, endHour: parseInt(e.target.value) })}
                  className="w-full mt-1 bg-transparent text-sm font-medium"
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={i}>{i.toString().padStart(2, '0')}:00</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
