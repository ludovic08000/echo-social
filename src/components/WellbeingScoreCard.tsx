import { useWellbeingScore, useComputeWellbeing } from '@/hooks/useWellbeingScore';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RefreshCw, Brain, Heart, Users, Palette, Coffee, Sparkles } from 'lucide-react';
import { motion } from 'framer-motion';

const DIMENSIONS = [
  { key: 'screen_time_score', label: 'Temps d\'écran', icon: Coffee, color: 'text-amber-400' },
  { key: 'social_balance_score', label: 'Équilibre social', icon: Users, color: 'text-blue-400' },
  { key: 'content_diversity_score', label: 'Diversité contenu', icon: Palette, color: 'text-purple-400' },
  { key: 'break_frequency_score', label: 'Pauses', icon: Brain, color: 'text-emerald-400' },
  { key: 'positivity_score', label: 'Positivité', icon: Heart, color: 'text-rose-400' },
] as const;

function ScoreRing({ score, size = 80 }: { score: number; size?: number }) {
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (score / 100) * circ;
  const color = score >= 70 ? '#22c55e' : score >= 40 ? '#f59e0b' : '#ef4444';

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth={6} />
        <motion.circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={color} strokeWidth={6} strokeLinecap="round"
          initial={{ strokeDashoffset: circ }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1, ease: 'easeOut' }}
          strokeDasharray={circ}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-lg font-bold text-foreground">{score}</span>
      </div>
    </div>
  );
}

function MiniBar({ value, label, icon: Icon, color }: { value: number; label: string; icon: React.ElementType; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className={`w-3.5 h-3.5 ${color} flex-shrink-0`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-0.5">
          <span className="text-[10px] text-muted-foreground truncate">{label}</span>
          <span className="text-[10px] font-semibold text-foreground">{value}</span>
        </div>
        <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
          <motion.div
            className="h-full rounded-full"
            style={{ backgroundColor: value >= 70 ? '#22c55e' : value >= 40 ? '#f59e0b' : '#ef4444' }}
            initial={{ width: 0 }}
            animate={{ width: `${value}%` }}
            transition={{ duration: 0.8, ease: 'easeOut' }}
          />
        </div>
      </div>
    </div>
  );
}

export function WellbeingScoreCard() {
  const { data: wb, isLoading } = useWellbeingScore();
  const compute = useComputeWellbeing();

  const score = wb?.score ?? 50;
  const label = score >= 80 ? 'Excellent 🌟' : score >= 60 ? 'Bon 👍' : score >= 40 ? 'Moyen ⚠️' : 'À améliorer 💪';

  return (
    <Card className="p-4 bg-card border-border/30 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Bien-être numérique</h3>
        </div>
        <Button
          variant="ghost" size="sm"
          className="h-7 w-7 p-0"
          onClick={() => compute.mutate()}
          disabled={compute.isPending}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${compute.isPending ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <div className="flex items-center gap-4">
        <ScoreRing score={score} />
        <div className="flex-1 space-y-0.5">
          <p className="text-sm font-semibold text-foreground">{label}</p>
          <p className="text-[10px] text-muted-foreground">
            Score basé sur tes habitudes des 7 derniers jours
          </p>
          {wb?.computed_at && (
            <p className="text-[9px] text-muted-foreground/60">
              Mis à jour {new Date(wb.computed_at).toLocaleDateString('fr-FR')}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {DIMENSIONS.map(({ key, label, icon, color }) => (
          <MiniBar key={key} value={(wb as any)?.[key] ?? 50} label={label} icon={icon} color={color} />
        ))}
      </div>
    </Card>
  );
}
