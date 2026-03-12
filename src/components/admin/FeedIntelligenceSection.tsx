import { useState, useEffect, useCallback } from 'react';
import { Activity, Brain, Zap, RotateCcw, Check, X, Clock, TrendingUp, AlertTriangle, Info, ChevronDown, ChevronUp, Cpu, BarChart3, Shield } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

interface MetricSummary {
  count: number;
  avg: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

interface Recommendation {
  id: string;
  recommendation_type: string;
  severity: string;
  title: string;
  description: string;
  suggested_action: any;
  auto_applicable: boolean;
  safe_bounds: any;
  status: string;
  created_at: string;
}

interface ConfigChange {
  id: string;
  config_key: string;
  old_value: any;
  new_value: any;
  change_source: string;
  ai_level: string;
  reason: string;
  applied_by: string;
  rolled_back: boolean;
  created_at: string;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'text-destructive bg-destructive/10 border-destructive/30',
  warning: 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30',
  info: 'text-primary bg-primary/10 border-primary/30',
};

const SEVERITY_ICONS: Record<string, typeof AlertTriangle> = {
  critical: AlertTriangle,
  warning: AlertTriangle,
  info: Info,
};

export function FeedIntelligenceSection() {
  const [metrics, setMetrics] = useState<Record<string, MetricSummary> | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [history, setHistory] = useState<ConfigChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [autoApplying, setAutoApplying] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Fetch everything
  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      // Observe (Level 1)
      const { data: obsData } = await supabase.functions.invoke('feed-optimizer', {
        body: { action: 'observe' },
      });
      if (obsData?.summary) setMetrics(obsData.summary);

      // Pending recommendations
      const { data: recos } = await supabase
        .from('feed_ai_recommendations')
        .select('*')
        .in('status', ['pending', 'applied'])
        .order('created_at', { ascending: false })
        .limit(20);
      setRecommendations((recos as any) || []);

      // Change history
      const { data: histData } = await supabase.functions.invoke('feed-optimizer', {
        body: { action: 'history' },
      });
      setHistory(histData?.changes || []);
    } catch (e) {
      console.error('Feed intelligence fetch error:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Level 2: Run analysis
  const runAnalysis = async () => {
    setAnalyzing(true);
    try {
      const { data } = await supabase.functions.invoke('feed-optimizer', {
        body: { action: 'recommend' },
      });
      toast({
        title: `Analyse terminée`,
        description: `${data?.count || 0} recommandation(s) générée(s).`,
      });
      fetchAll();
    } catch {
      toast({ title: 'Erreur d\'analyse', variant: 'destructive' });
    } finally {
      setAnalyzing(false);
    }
  };

  // Level 3: Auto-apply safe changes
  const autoApply = async () => {
    setAutoApplying(true);
    try {
      const { data } = await supabase.functions.invoke('feed-optimizer', {
        body: { action: 'auto_apply' },
      });
      toast({
        title: `${data?.applied || 0} ajustement(s) appliqué(s)`,
        description: data?.changes?.map((c: any) => `${c.key}: ${c.old} → ${c.new}`).join(', ') || 'Aucun changement.',
      });
      fetchAll();
    } catch {
      toast({ title: 'Erreur d\'application', variant: 'destructive' });
    } finally {
      setAutoApplying(false);
    }
  };

  // Dismiss a recommendation
  const dismissReco = async (id: string) => {
    await supabase
      .from('feed_ai_recommendations')
      .update({ status: 'dismissed', dismissed_at: new Date().toISOString() } as any)
      .eq('id', id);
    setRecommendations(prev => prev.filter(r => r.id !== id));
  };

  // Rollback a change
  const rollback = async (changeId: string) => {
    try {
      await supabase.functions.invoke('feed-optimizer', {
        body: { action: 'rollback', change_id: changeId },
      });
      toast({ title: 'Rollback effectué ✅' });
      fetchAll();
    } catch {
      toast({ title: 'Erreur de rollback', variant: 'destructive' });
    }
  };

  const metricLabels: Record<string, { label: string; unit: string; icon: typeof Activity }> = {
    load_time: { label: 'Temps de chargement', unit: 'ms', icon: Clock },
    scroll_depth: { label: 'Profondeur de scroll', unit: '%', icon: TrendingUp },
    posts_rendered: { label: 'Posts affichés', unit: '', icon: BarChart3 },
    fps: { label: 'FPS', unit: '', icon: Cpu },
    engagement_rate: { label: 'Actions / session', unit: '', icon: Zap },
    abandonment: { label: 'Abandons', unit: '', icon: AlertTriangle },
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center">
            <Brain className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <h2 className="text-lg font-bold">Feed Intelligence</h2>
            <p className="text-xs text-muted-foreground">IA observatrice · recommandatrice · semi-autonome</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={runAnalysis} disabled={analyzing} className="gap-1.5">
            <Activity className="w-3.5 h-3.5" />
            {analyzing ? 'Analyse…' : 'Analyser'}
          </Button>
          <Button size="sm" onClick={autoApply} disabled={autoApplying} className="gap-1.5">
            <Zap className="w-3.5 h-3.5" />
            {autoApplying ? 'Application…' : 'Auto-optimiser'}
          </Button>
        </div>
      </div>

      {/* Level badges */}
      <div className="flex gap-2 flex-wrap">
        <Badge variant="outline" className="gap-1 text-xs border-primary/30 text-primary">
          <Shield className="w-3 h-3" /> Niveau 1 : Observer
        </Badge>
        <Badge variant="outline" className="gap-1 text-xs border-amber-500/30 text-amber-600 dark:text-amber-400">
          <Brain className="w-3 h-3" /> Niveau 2 : Recommander
        </Badge>
        <Badge variant="outline" className="gap-1 text-xs border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
          <Zap className="w-3 h-3" /> Niveau 3 : Semi-autonome
        </Badge>
      </div>

      {/* ── Level 1: Metrics Dashboard ── */}
      <div>
        <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
          <Activity className="w-4 h-4 text-primary" />
          Métriques en temps réel
        </h3>
        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {[1,2,3,4,5,6].map(i => (
              <div key={i} className="h-24 rounded-xl bg-muted/40 animate-pulse" />
            ))}
          </div>
        ) : metrics ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {Object.entries(metricLabels).map(([key, meta]) => {
              const m = metrics[key];
              if (!m) return (
                <Card key={key} className="p-4 bg-secondary/20">
                  <div className="flex items-center gap-2 mb-2">
                    <meta.icon className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground">{meta.label}</span>
                  </div>
                  <p className="text-lg font-bold text-muted-foreground">—</p>
                </Card>
              );
              return (
                <Card key={key} className="p-4 bg-secondary/20 border-border/30">
                  <div className="flex items-center gap-2 mb-2">
                    <meta.icon className="w-4 h-4 text-primary" />
                    <span className="text-xs font-medium text-muted-foreground">{meta.label}</span>
                  </div>
                  <p className="text-xl font-bold">{m.avg}{meta.unit}</p>
                  <div className="flex gap-2 mt-1 text-[10px] text-muted-foreground">
                    <span>P95: {m.p95}{meta.unit}</span>
                    <span>·</span>
                    <span>{m.count} pts</span>
                  </div>
                </Card>
              );
            })}
          </div>
        ) : (
          <Card className="p-6 text-center text-muted-foreground text-sm">
            Pas encore de métriques collectées. Les données apparaîtront dès que les utilisateurs navigueront le feed.
          </Card>
        )}
      </div>

      {/* ── Level 2: Recommendations ── */}
      <div>
        <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
          <Brain className="w-4 h-4 text-amber-500" />
          Recommandations IA
          {recommendations.filter(r => r.status === 'pending').length > 0 && (
            <Badge className="bg-amber-500/20 text-amber-600 text-[10px]">
              {recommendations.filter(r => r.status === 'pending').length} en attente
            </Badge>
          )}
        </h3>
        {recommendations.length === 0 ? (
          <Card className="p-6 text-center text-muted-foreground text-sm">
            Aucune recommandation. Lancez une analyse pour générer des insights.
          </Card>
        ) : (
          <div className="space-y-2">
            {recommendations.map(reco => {
              const Icon = SEVERITY_ICONS[reco.severity] || Info;
              return (
                <Card key={reco.id} className={cn('p-4 border', SEVERITY_COLORS[reco.severity] || '')}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Icon className="w-4 h-4 shrink-0" />
                        <span className="font-semibold text-sm">{reco.title}</span>
                        {reco.auto_applicable && (
                          <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                            auto
                          </Badge>
                        )}
                        {reco.status === 'applied' && (
                          <Badge className="text-[9px] px-1.5 py-0 bg-emerald-500/20 text-emerald-600">
                            ✓ appliqué
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs opacity-80">{reco.description}</p>
                      {reco.suggested_action && reco.suggested_action.key && (
                        <div className="mt-2 text-[10px] bg-background/50 rounded-lg px-2 py-1 inline-flex gap-2 font-mono">
                          <span>{reco.suggested_action.key}:</span>
                          <span className="line-through opacity-50">{reco.suggested_action.current}</span>
                          <span>→</span>
                          <span className="font-bold">{reco.suggested_action.suggested}</span>
                          {reco.safe_bounds && (
                            <span className="opacity-50">[{reco.safe_bounds.min}–{reco.safe_bounds.max}]</span>
                          )}
                        </div>
                      )}
                    </div>
                    {reco.status === 'pending' && (
                      <button onClick={() => dismissReco(reco.id)} className="p-1 rounded hover:bg-background/50 transition-colors shrink-0">
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Config Change History ── */}
      <div>
        <button
          onClick={() => setShowHistory(!showHistory)}
          className="flex items-center gap-2 font-semibold text-sm mb-3 hover:text-primary transition-colors"
        >
          <RotateCcw className="w-4 h-4 text-muted-foreground" />
          Historique des changements
          {showHistory ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          {history.length > 0 && (
            <Badge variant="secondary" className="text-[10px]">{history.length}</Badge>
          )}
        </button>
        {showHistory && (
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {history.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">Aucun changement enregistré.</p>
            ) : (
              history.map(change => (
                <Card key={change.id} className={cn('p-3 text-sm', change.rolled_back && 'opacity-50')}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <code className="text-xs font-mono bg-muted/50 px-1.5 py-0.5 rounded">{change.config_key}</code>
                        <span className="text-xs text-muted-foreground">
                          {JSON.stringify(change.old_value)} → {JSON.stringify(change.new_value)}
                        </span>
                        <Badge variant="outline" className="text-[9px] px-1">
                          {change.change_source === 'ai_auto' ? '🤖 auto' : change.change_source === 'ai_recommendation' ? '💡 reco' : '✋ manuel'}
                        </Badge>
                        {change.rolled_back && (
                          <Badge variant="destructive" className="text-[9px] px-1">rollback</Badge>
                        )}
                      </div>
                      {change.reason && (
                        <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{change.reason}</p>
                      )}
                    </div>
                    {!change.rolled_back && (
                      <Button size="sm" variant="ghost" onClick={() => rollback(change.id)} className="shrink-0 h-7 text-xs gap-1">
                        <RotateCcw className="w-3 h-3" />
                        Annuler
                      </Button>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {new Date(change.created_at).toLocaleString('fr')}
                    {change.applied_by && ` · par ${change.applied_by}`}
                  </p>
                </Card>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
