import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { 
  Shield, ShieldAlert, ShieldCheck, Activity, Brain, Eye, 
  RefreshCw, AlertTriangle, Bug, Zap, TrendingUp, Mail, Search,
  Target, Timer, Gauge, BarChart3
} from 'lucide-react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-600 text-white',
  high: 'bg-orange-500 text-white',
  medium: 'bg-amber-500 text-white',
  low: 'bg-blue-500 text-white',
};

const AUTONOMY_LABELS: Record<number, { label: string; color: string; icon: string }> = {
  1: { label: 'Local seul', color: 'bg-blue-500/10 text-blue-600', icon: '⚡' },
  2: { label: 'Local + Gemini', color: 'bg-amber-500/10 text-amber-600', icon: '🤖' },
  3: { label: 'Auto-block', color: 'bg-red-500/10 text-red-600', icon: '🔒' },
};

const STATUS_ICONS: Record<string, typeof ShieldCheck> = {
  safe: ShieldCheck,
  at_risk: ShieldAlert,
  under_attack: AlertTriangle,
};

export function SecurityMonitoringSection() {
  const [search, setSearch] = useState('');
  const queryClient = useQueryClient();

  const { data: incidents, isLoading: incidentsLoading } = useQuery({
    queryKey: ['security-incidents'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('security_incidents')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
    refetchInterval: 30000,
  });

  const { data: patterns } = useQuery({
    queryKey: ['security-ai-patterns'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('security_ai_patterns')
        .select('*')
        .eq('is_active', true)
        .order('confidence', { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: alertConfig } = useQuery({
    queryKey: ['security-alert-config'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('security_alert_config')
        .select('*')
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // Quality metrics
  const { data: qualityMetrics } = useQuery({
    queryKey: ['security-quality-metrics'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('security_quality_metrics' as any)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data as any[];
    },
  });

  const [lastScanResult, setLastScanResult] = useState<any>(null);

  const runScan = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('security-monitor');
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      setLastScanResult(data);
      toast({
        title: '🔍 Scan terminé',
        description: `${data.incidents_detected} incidents | Niv.${data.autonomy_level} | ${Math.round(data.autonomy_score * 100)}% autonomie | ${data.reaction_time_ms}ms`,
      });
      queryClient.invalidateQueries({ queryKey: ['security-incidents'] });
      queryClient.invalidateQueries({ queryKey: ['security-ai-patterns'] });
      queryClient.invalidateQueries({ queryKey: ['security-quality-metrics'] });
    },
    onError: (e: any) => toast({ title: 'Erreur scan', description: e.message, variant: 'destructive' }),
  });

  // Stats
  const totalIncidents = incidents?.length || 0;
  const criticalCount = incidents?.filter(i => i.severity === 'critical').length || 0;
  const successfulAttacks = incidents?.filter(i => i.success).length || 0;
  const blockedAttacks = incidents?.filter(i => !i.success).length || 0;
  const patternCount = patterns?.length || 0;

  // Quality aggregates
  const recentMetrics = qualityMetrics?.slice(0, 10) || [];
  const avgAutonomy = recentMetrics.length > 0 
    ? recentMetrics.reduce((s, m) => s + Number(m.autonomy_score || 0), 0) / recentMetrics.length 
    : 0;
  const avgReactionTime = recentMetrics.length > 0
    ? Math.round(recentMetrics.reduce((s, m) => s + (m.reaction_time_ms || 0), 0) / recentMetrics.length)
    : 0;
  const totalGeminiCalls = recentMetrics.reduce((s, m) => s + (m.gemini_calls || 0), 0);
  const totalScans = recentMetrics.length;
  const costSavedScans = recentMetrics.filter(m => m.ai_cost_saved).length;

  const platformHealth = criticalCount > 0 ? 'under_attack' : successfulAttacks > 0 ? 'at_risk' : 'safe';
  const HealthIcon = STATUS_ICONS[platformHealth] || ShieldCheck;

  const filteredIncidents = incidents?.filter(i =>
    !search.trim() ||
    i.incident_type?.toLowerCase().includes(search.toLowerCase()) ||
    i.source_ip?.toLowerCase().includes(search.toLowerCase()) ||
    i.attack_vector?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
          <Shield className="w-5 h-5 text-primary" />
          IA Security Monitoring
        </h2>
        <Button onClick={() => runScan.mutate()} disabled={runScan.isPending} size="sm">
          {runScan.isPending ? <RefreshCw className="w-4 h-4 animate-spin mr-1" /> : <Zap className="w-4 h-4 mr-1" />}
          Lancer un scan
        </Button>
      </div>

      {/* Health & Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[
          { label: 'Santé plateforme', value: platformHealth === 'safe' ? '✅ Sûre' : platformHealth === 'at_risk' ? '⚠️ À risque' : '🔴 Attaque', icon: HealthIcon, color: platformHealth === 'safe' ? 'text-green-600 bg-green-500/10' : platformHealth === 'at_risk' ? 'text-amber-600 bg-amber-500/10' : 'text-red-600 bg-red-500/10' },
          { label: 'Incidents', value: totalIncidents, icon: Activity, color: 'text-blue-600 bg-blue-500/10' },
          { label: 'Attaques bloquées', value: blockedAttacks, icon: ShieldCheck, color: 'text-green-600 bg-green-500/10' },
          { label: 'Patterns appris', value: patternCount, icon: Brain, color: 'text-purple-600 bg-purple-500/10' },
          { label: 'Autonomie moy.', value: `${Math.round(avgAutonomy * 100)}%`, icon: Gauge, color: 'text-primary bg-primary/10' },
        ].map((card, i) => (
          <motion.div key={card.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center', card.color)}>
                    <card.icon className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-lg font-bold text-foreground">{card.value}</p>
                    <p className="text-[10px] text-muted-foreground">{card.label}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* ÉTAPE 4 : Quality Metrics Dashboard */}
      {recentMetrics.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-primary" /> Métriques de qualité IA (derniers {totalScans} scans)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
              <div className="p-3 rounded-xl bg-secondary/30 border border-border/50 text-center">
                <Target className="w-5 h-5 mx-auto mb-1 text-green-500" />
                <p className="text-lg font-bold text-foreground">{Math.round(avgAutonomy * 100)}%</p>
                <p className="text-[10px] text-muted-foreground">Taux d'autonomie</p>
              </div>
              <div className="p-3 rounded-xl bg-secondary/30 border border-border/50 text-center">
                <Timer className="w-5 h-5 mx-auto mb-1 text-blue-500" />
                <p className="text-lg font-bold text-foreground">{avgReactionTime}ms</p>
                <p className="text-[10px] text-muted-foreground">Temps de réaction moy.</p>
              </div>
              <div className="p-3 rounded-xl bg-secondary/30 border border-border/50 text-center">
                <Brain className="w-5 h-5 mx-auto mb-1 text-purple-500" />
                <p className="text-lg font-bold text-foreground">{totalGeminiCalls}</p>
                <p className="text-[10px] text-muted-foreground">Appels Gemini</p>
              </div>
              <div className="p-3 rounded-xl bg-secondary/30 border border-border/50 text-center">
                <Zap className="w-5 h-5 mx-auto mb-1 text-amber-500" />
                <p className="text-lg font-bold text-foreground">{totalScans > 0 ? Math.round(costSavedScans / totalScans * 100) : 0}%</p>
                <p className="text-[10px] text-muted-foreground">Scans sans API</p>
              </div>
            </div>

            {/* Mini timeline */}
            <div className="flex gap-1 items-end h-12">
              {recentMetrics.slice().reverse().map((m, i) => {
                const score = Number(m.autonomy_score || 0);
                return (
                  <div
                    key={i}
                    className={cn(
                      "flex-1 rounded-t transition-all",
                      score >= 0.8 ? "bg-green-500" : score >= 0.5 ? "bg-amber-500" : "bg-red-500"
                    )}
                    style={{ height: `${Math.max(4, score * 48)}px` }}
                    title={`Scan ${i + 1}: ${Math.round(score * 100)}% autonomie`}
                  />
                );
              })}
            </div>
            <p className="text-[10px] text-muted-foreground text-center mt-1">Progression d'autonomie par scan</p>
          </CardContent>
        </Card>
      )}

      {/* Alert Config */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <Mail className="w-4 h-4 text-muted-foreground" />
              <span className="text-muted-foreground">Alertes email :</span>
              <span className="font-medium text-foreground">{alertConfig?.alert_email || 'Non configuré'}</span>
              <Badge variant="secondary" className="text-[10px]">Sévérité min: {alertConfig?.min_severity || 'medium'}</Badge>
            </div>
            {alertConfig?.is_active && <Badge className="bg-green-500/10 text-green-600 text-[10px]">Actif</Badge>}
          </div>
        </CardContent>
      </Card>

      {/* Incidents Table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> Incidents de sécurité
            </CardTitle>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input placeholder="Filtrer..." value={search} onChange={e => setSearch(e.target.value)} className="pl-7 h-8 w-48 text-xs" />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Sévérité</TableHead>
                  <TableHead>Confiance</TableHead>
                  <TableHead>Niveau</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>Résultat</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {incidentsLoading ? (
                  <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Chargement...</TableCell></TableRow>
                ) : !filteredIncidents?.length ? (
                  <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    <ShieldCheck className="w-8 h-8 mx-auto mb-2 text-green-500" />
                    Aucun incident. Plateforme sécurisée.
                  </TableCell></TableRow>
                ) : filteredIncidents.slice(0, 50).map((inc) => {
                  const confScore = Number(inc.confidence_score || 0);
                  const autoLevel = inc.autonomy_level || 1;
                  const levelInfo = AUTONOMY_LABELS[autoLevel] || AUTONOMY_LABELS[1];
                  return (
                    <TableRow key={inc.id}>
                      <TableCell>
                        <Badge variant="secondary" className="text-[10px]">{inc.incident_type}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge className={cn('text-[10px]', SEVERITY_COLORS[inc.severity] || 'bg-secondary')}>
                          {inc.severity}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <div className="w-10 h-1.5 rounded-full bg-secondary overflow-hidden">
                            <div
                              className={cn("h-full rounded-full", confScore >= 0.7 ? "bg-red-500" : confScore >= 0.4 ? "bg-amber-500" : "bg-green-500")}
                              style={{ width: `${Math.round(confScore * 100)}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-muted-foreground">{Math.round(confScore * 100)}%</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge className={cn('text-[10px]', levelInfo.color)}>
                          {levelInfo.icon} Niv.{autoLevel}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs font-mono">{inc.source_ip || '-'}</TableCell>
                      <TableCell>
                        {inc.success ? (
                          <Badge variant="destructive" className="text-[10px]">⚠️ Réussie</Badge>
                        ) : (
                          <Badge className="bg-green-500/10 text-green-600 text-[10px]">✅ Bloquée</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="text-[10px] text-muted-foreground">{inc.detection_source || 'heuristic'}</span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {format(new Date(inc.created_at), 'dd/MM HH:mm', { locale: fr })}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* AI Learned Patterns with Autonomy Levels */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Brain className="w-4 h-4 text-purple-500" /> Patterns IA — Autonomie progressive
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!patterns?.length ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              Lancez un scan pour démarrer l'apprentissage.
            </p>
          ) : (
            <div className="space-y-2">
              {patterns.map(p => {
                const autoLevel = p.autonomy_level || 1;
                const levelInfo = AUTONOMY_LABELS[autoLevel] || AUTONOMY_LABELS[1];
                return (
                  <div key={p.id} className="flex items-center justify-between p-3 rounded-xl bg-secondary/30 border border-border/50">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{p.pattern_name}</span>
                        <Badge className={cn('text-[10px]', SEVERITY_COLORS[p.severity] || 'bg-secondary')}>{p.severity}</Badge>
                        <Badge className={cn('text-[10px]', levelInfo.color)}>{levelInfo.icon} Niv.{autoLevel}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{p.detection_rule}</p>
                    </div>
                    <div className="flex items-center gap-3 ml-3">
                      <div className="text-right">
                        <p className="text-xs font-medium text-foreground">Confiance: {Math.round((p.confidence || 0) * 100)}%</p>
                        <p className="text-[10px] text-muted-foreground">{p.times_matched} détections · {p.confirmed_count || 0} confirmés</p>
                      </div>
                      <div className="w-16 h-2 rounded-full bg-secondary overflow-hidden">
                        <div 
                          className={cn("h-full rounded-full transition-all", autoLevel === 3 ? "bg-red-500" : autoLevel === 2 ? "bg-amber-500" : "bg-purple-500")}
                          style={{ width: `${Math.round((p.confidence || 0) * 100)}%` }} 
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-3 p-3 rounded-lg bg-secondary/20 border border-border/30">
            <p className="text-[10px] text-muted-foreground">
              <strong>Niveaux d'autonomie :</strong> ⚡ Niv.1 = détection locale seule · 🤖 Niv.2 = validation Gemini si doute · 🔒 Niv.3 = auto-block (pattern confirmé ≥3x, confiance ≥85%)
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Last Scan Result */}
      {lastScanResult && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" /> Dernier scan — {lastScanResult.scan_id}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Mode :</span>
                <Badge variant={lastScanResult.ai_used ? 'secondary' : 'default'} className="text-[10px]">
                  {lastScanResult.ai_used ? '🤖 IA + Local' : '⚡ 100% Autonome'}
                </Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Détections :</span>
                <span className="font-medium text-foreground">{lastScanResult.local_detections}/{lastScanResult.incidents_detected}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Auto-blocks :</span>
                <span className="font-bold text-red-500">{lastScanResult.auto_blocks || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Réaction :</span>
                <span className="font-medium text-foreground">{lastScanResult.reaction_time_ms}ms</span>
              </div>
            </div>

            {/* Autonomy score bar */}
            <div>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-muted-foreground">Score d'autonomie :</span>
                <span className="font-bold text-foreground">{Math.round((lastScanResult.autonomy_score || 0) * 100)}%</span>
              </div>
              <div className="w-full h-3 rounded-full bg-secondary overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-primary/70 to-primary transition-all duration-500"
                  style={{ width: `${Math.round((lastScanResult.autonomy_score || 0) * 100)}%` }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                {(lastScanResult.autonomy_score || 0) >= 0.8 ? '🟢 IA locale quasi-autonome — Gemini rarement nécessaire' :
                 (lastScanResult.autonomy_score || 0) >= 0.5 ? '🟡 Apprentissage en cours — Gemini pour les cas ambigus' :
                 '🔴 Phase d\'apprentissage — Plus de scans nécessaires'}
              </p>
            </div>

            {lastScanResult.self_improvement && (
              <div className="p-3 rounded-lg bg-secondary/30 border border-border/50">
                <p className="text-[10px] font-medium text-muted-foreground mb-1">🧠 Auto-amélioration :</p>
                <p className="text-xs text-foreground">{lastScanResult.self_improvement}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
