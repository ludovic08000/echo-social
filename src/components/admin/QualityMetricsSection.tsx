import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import {
  Clock,
  PlayCircle,
  SkipForward,
  Repeat,
  Share2,
  Bookmark,
  Users,
  Smartphone,
  TrendingUp,
  Eye,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type Surface = 'all' | 'video' | 'post' | 'live';

interface Summary {
  total_views: number;
  avg_watch_ms: number;
  total_watch_ms: number;
  avg_completion_pct: number;
  skip_fast_count: number;
  rewatch_count: number;
  share_count: number;
  save_count: number;
  return_sessions: number;
  unique_viewers: number;
  ios_share_pct: number;
  ios_avg_perf_ms: number;
}

interface TimelinePoint {
  bucket: string;
  views: number;
  avg_completion: number;
  avg_watch_ms: number;
  skip_fast: number;
  ios_perf_ms: number;
}

const SURFACES: { id: Surface; label: string }[] = [
  { id: 'all', label: 'Tout' },
  { id: 'video', label: 'Vidéos' },
  { id: 'post', label: 'Posts' },
  { id: 'live', label: 'Lives' },
];

function formatMs(ms: number): string {
  if (!ms || ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function KPI({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  icon: typeof Eye;
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const tones = {
    neutral: 'text-foreground',
    good: 'text-emerald-500',
    warn: 'text-amber-500',
    bad: 'text-destructive',
  };
  return (
    <Card className="p-4 rounded-2xl border-border/30 bg-card/60 backdrop-blur">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className={cn('w-4 h-4', tones[tone])} />
      </div>
      <div className={cn('text-2xl font-bold tracking-tight', tones[tone])}>{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-1">{hint}</div>}
    </Card>
  );
}

function MiniBars({ points, accessor }: { points: TimelinePoint[]; accessor: (p: TimelinePoint) => number }) {
  if (!points.length) return <div className="text-xs text-muted-foreground py-4">Aucune donnée</div>;
  const max = Math.max(...points.map(accessor), 1);
  return (
    <div className="flex items-end gap-0.5 h-24">
      {points.map((p, i) => {
        const h = Math.max(2, (accessor(p) / max) * 100);
        return (
          <div
            key={i}
            className="flex-1 bg-gradient-to-t from-primary/40 to-primary rounded-sm hover:opacity-80 transition-opacity"
            style={{ height: `${h}%` }}
            title={`${new Date(p.bucket).toLocaleString('fr')} • ${accessor(p)}`}
          />
        );
      })}
    </div>
  );
}

export function QualityMetricsSection() {
  const [surface, setSurface] = useState<Surface>('all');
  const [range, setRange] = useState<'24h' | '7d' | '30d'>('7d');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const ms = range === '24h' ? 86400000 : range === '7d' ? 7 * 86400000 : 30 * 86400000;
      const since = new Date(Date.now() - ms).toISOString();
      const bucket = range === '24h' ? 'hour' : 'day';

      const [{ data: sum }, { data: tl }] = await Promise.all([
        supabase.rpc('quality_metrics_summary' as any, {
          p_surface: surface === 'all' ? null : surface,
          p_since: since,
        }),
        supabase.rpc('quality_metrics_timeline' as any, {
          p_surface: surface === 'all' ? null : surface,
          p_since: since,
          p_bucket: bucket,
        }),
      ]);

      if (!alive) return;
      setSummary((sum as Summary) || null);
      setTimeline(((tl as TimelinePoint[]) || []).slice(-48));
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [surface, range]);

  const completionTone =
    !summary ? 'neutral' : summary.avg_completion_pct >= 60 ? 'good' : summary.avg_completion_pct >= 30 ? 'warn' : 'bad';
  const skipRate =
    summary && summary.total_views > 0 ? (summary.skip_fast_count / summary.total_views) * 100 : 0;
  const skipTone = skipRate >= 40 ? 'bad' : skipRate >= 20 ? 'warn' : 'good';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Qualité de visionnage</h2>
          <p className="text-sm text-muted-foreground">
            Mesure réelle prod — videos, posts, lives. iOS isolé.
          </p>
        </div>
        <div className="flex gap-2">
          {(['24h', '7d', '30d'] as const).map(r => (
            <Badge
              key={r}
              variant={range === r ? 'default' : 'outline'}
              className="cursor-pointer rounded-full px-3 py-1"
              onClick={() => setRange(r)}
            >
              {r}
            </Badge>
          ))}
        </div>
      </div>

      <Tabs value={surface} onValueChange={v => setSurface(v as Surface)}>
        <TabsList className="rounded-full">
          {SURFACES.map(s => (
            <TabsTrigger key={s.id} value={s.id} className="rounded-full">
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={surface} className="mt-6 space-y-6">
          {loading || !summary ? (
            <div className="text-sm text-muted-foreground py-12 text-center">Chargement…</div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                <KPI icon={Eye} label="Vues" value={summary.total_views.toLocaleString('fr')} />
                <KPI icon={Users} label="Spectateurs uniques" value={summary.unique_viewers.toLocaleString('fr')} />
                <KPI
                  icon={Clock}
                  label="Temps moyen"
                  value={formatMs(summary.avg_watch_ms)}
                  hint={`Total ${formatMs(summary.total_watch_ms)}`}
                />
                <KPI
                  icon={PlayCircle}
                  label="Complétion moy."
                  value={`${summary.avg_completion_pct}%`}
                  tone={completionTone}
                />
                <KPI
                  icon={SkipForward}
                  label="Skip rapide"
                  value={`${skipRate.toFixed(1)}%`}
                  hint={`${summary.skip_fast_count} skips`}
                  tone={skipTone}
                />
                <KPI icon={Repeat} label="Rewatch" value={summary.rewatch_count} />
                <KPI icon={Share2} label="Partages" value={summary.share_count} />
                <KPI icon={Bookmark} label="Sauvegardes" value={summary.save_count} />
                <KPI
                  icon={TrendingUp}
                  label="Taux de retour"
                  value={summary.return_sessions}
                  hint="Sessions après >30min"
                />
                <KPI
                  icon={Smartphone}
                  label="Perf iOS"
                  value={`${summary.ios_share_pct}%`}
                  hint={`Lat. ~${formatMs(summary.ios_avg_perf_ms)}`}
                  tone={summary.ios_avg_perf_ms > 8000 ? 'warn' : 'neutral'}
                />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card className="p-4 rounded-2xl border-border/30 bg-card/60">
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Eye className="w-4 h-4" /> Vues — {range}
                  </h3>
                  <MiniBars points={timeline} accessor={p => p.views} />
                </Card>
                <Card className="p-4 rounded-2xl border-border/30 bg-card/60">
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <PlayCircle className="w-4 h-4" /> Complétion %
                  </h3>
                  <MiniBars points={timeline} accessor={p => Number(p.avg_completion) || 0} />
                </Card>
                <Card className="p-4 rounded-2xl border-border/30 bg-card/60">
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <SkipForward className="w-4 h-4" /> Skips rapides
                  </h3>
                  <MiniBars points={timeline} accessor={p => p.skip_fast} />
                </Card>
                <Card className="p-4 rounded-2xl border-border/30 bg-card/60">
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Smartphone className="w-4 h-4" /> Perf iOS (ms)
                  </h3>
                  <MiniBars points={timeline} accessor={p => Number(p.ios_perf_ms) || 0} />
                </Card>
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
