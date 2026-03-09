import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { toast } from '@/hooks/use-toast';
import {
  Activity, AlertTriangle, CheckCircle2, Database, HardDrive,
  RefreshCw, Search, Shield, Trash2, Users, Zap, Loader2
} from 'lucide-react';
import { motion } from 'framer-motion';

interface HealthReport {
  duplicates?: {
    duplicate_names: Array<{ name: string; count: number; profiles: any[] }>;
    multi_accounts: Array<{ fingerprint: string; user_ids: string[]; count: number }>;
    total_duplicate_name_groups: number;
    total_multi_account_groups: number;
  };
  coherence?: {
    checks: Array<{ check: string; issues: number }>;
    total_issues: number;
  };
  cleanup?: {
    actions: Array<{ action: string; count: number }>;
    total_cleaned: number;
  };
  health?: {
    total_rows: number;
    table_counts: Array<{ table: string; count: number }>;
    flagged_users: number;
    pending_reports: number;
    active_lives: number;
    analyzed_at: string;
  };
}

export function PlatformHealthDashboard() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  const runAnalysis = async (action: string) => {
    setLoading(action);
    try {
      const { data, error } = await supabase.functions.invoke('platform-health', {
        body: { action },
      });
      if (error) throw error;
      setReport(prev => ({ ...prev, ...data }));
      toast({ title: 'Analyse terminée ✅' });
    } catch (e: any) {
      toast({ title: 'Erreur', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(null);
    }
  };

  const getHealthScore = () => {
    if (!report?.coherence && !report?.duplicates) return null;
    let score = 100;
    if (report.coherence) score -= Math.min(report.coherence.total_issues * 2, 30);
    if (report.duplicates) {
      score -= Math.min(report.duplicates.total_multi_account_groups * 5, 25);
      score -= Math.min(report.duplicates.total_duplicate_name_groups * 1, 15);
    }
    if (report.health?.flagged_users) score -= Math.min(report.health.flagged_users * 3, 20);
    return Math.max(score, 0);
  };

  const healthScore = getHealthScore();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="w-6 h-6 text-primary" />
            Santé de la plateforme
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Analyse complète : doublons, cohérence, nettoyage et rapport global
          </p>
        </div>
        <Button
          onClick={() => runAnalysis('full')}
          disabled={loading !== null}
          className="gap-2"
        >
          {loading === 'full' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
          Analyse complète
        </Button>
      </div>

      {/* Health Score */}
      {healthScore !== null && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <Card className={`border-2 ${healthScore >= 80 ? 'border-green-500/30 bg-green-500/5' : healthScore >= 50 ? 'border-yellow-500/30 bg-yellow-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className={`text-4xl font-bold ${healthScore >= 80 ? 'text-green-500' : healthScore >= 50 ? 'text-yellow-500' : 'text-red-500'}`}>
                  {healthScore}/100
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium mb-2">Score de santé global</p>
                  <Progress value={healthScore} className="h-3" />
                </div>
                {healthScore >= 80 ? (
                  <CheckCircle2 className="w-8 h-8 text-green-500" />
                ) : (
                  <AlertTriangle className="w-8 h-8 text-yellow-500" />
                )}
              </div>
              {report.health && (
                <div className="grid grid-cols-4 gap-4 mt-4 pt-4 border-t border-border/50">
                  <div className="text-center">
                    <p className="text-2xl font-bold">{report.health.total_rows.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">Lignes en base</p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold">{report.health.flagged_users}</p>
                    <p className="text-xs text-muted-foreground">Utilisateurs signalés</p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold">{report.health.pending_reports}</p>
                    <p className="text-xs text-muted-foreground">Signalements en attente</p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold">{report.health.active_lives}</p>
                    <p className="text-xs text-muted-foreground">Lives actifs</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Action Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Duplicates */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Users className="w-4 h-4 text-orange-500" />
                Détection de doublons
              </span>
              <Button size="sm" variant="outline" onClick={() => runAnalysis('duplicates')} disabled={loading !== null}>
                {loading === 'duplicates' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {report?.duplicates ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/30">
                  <span className="text-sm">Noms en double</span>
                  <Badge variant={report.duplicates.total_duplicate_name_groups > 0 ? "destructive" : "secondary"}>
                    {report.duplicates.total_duplicate_name_groups} groupes
                  </Badge>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/30">
                  <span className="text-sm">Multi-comptes (fingerprint)</span>
                  <Badge variant={report.duplicates.total_multi_account_groups > 0 ? "destructive" : "secondary"}>
                    {report.duplicates.total_multi_account_groups} groupes
                  </Badge>
                </div>
                {report.duplicates.multi_accounts.slice(0, 3).map((ma, i) => (
                  <div key={i} className="text-xs text-muted-foreground p-2 rounded bg-destructive/5 border border-destructive/10">
                    🔗 {ma.fingerprint} → {ma.count} comptes liés
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Lancez l'analyse pour détecter les doublons</p>
            )}
          </CardContent>
        </Card>

        {/* Coherence */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Database className="w-4 h-4 text-blue-500" />
                Cohérence de la base
              </span>
              <Button size="sm" variant="outline" onClick={() => runAnalysis('coherence')} disabled={loading !== null}>
                {loading === 'coherence' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Shield className="w-3 h-3" />}
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {report?.coherence ? (
              <div className="space-y-2">
                {report.coherence.checks.map((c, i) => (
                  <div key={i} className="flex items-center justify-between p-2.5 rounded-lg bg-secondary/30">
                    <span className="text-sm">{c.check}</span>
                    {c.issues === 0 ? (
                      <CheckCircle2 className="w-4 h-4 text-green-500" />
                    ) : (
                      <Badge variant="destructive" className="text-xs">{c.issues}</Badge>
                    )}
                  </div>
                ))}
                <div className="pt-2 border-t border-border/50 flex justify-between items-center">
                  <span className="text-sm font-medium">Total anomalies</span>
                  <span className={`text-lg font-bold ${report.coherence.total_issues === 0 ? 'text-green-500' : 'text-destructive'}`}>
                    {report.coherence.total_issues}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Vérifiez les relations entre les tables</p>
            )}
          </CardContent>
        </Card>

        {/* Cleanup */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Trash2 className="w-4 h-4 text-red-500" />
                Nettoyage automatique
              </span>
              <Button size="sm" variant="outline" onClick={() => runAnalysis('cleanup')} disabled={loading !== null}>
                {loading === 'cleanup' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {report?.cleanup ? (
              <div className="space-y-2">
                {report.cleanup.actions.length === 0 ? (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 text-green-700">
                    <CheckCircle2 className="w-4 h-4" />
                    <span className="text-sm">Base de données propre, rien à nettoyer</span>
                  </div>
                ) : (
                  report.cleanup.actions.map((a, i) => (
                    <div key={i} className="flex items-center justify-between p-2.5 rounded-lg bg-secondary/30">
                      <span className="text-sm">{a.action}</span>
                      <Badge variant="secondary">{a.count}</Badge>
                    </div>
                  ))
                )}
                <div className="pt-2 border-t border-border/50 flex justify-between items-center">
                  <span className="text-sm font-medium">Total nettoyé</span>
                  <span className="text-lg font-bold text-primary">{report.cleanup.total_cleaned}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Supprimez les données expirées et inutiles</p>
            )}
          </CardContent>
        </Card>

        {/* Table Report */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center justify-between">
              <span className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-purple-500" />
                Rapport des tables
              </span>
              <Button size="sm" variant="outline" onClick={() => runAnalysis('health')} disabled={loading !== null}>
                {loading === 'health' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3" />}
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {report?.health ? (
              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {report.health.table_counts.map((t, i) => (
                  <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded text-sm hover:bg-secondary/30">
                    <span className="font-mono text-xs">{t.table}</span>
                    <span className="text-muted-foreground tabular-nums">{t.count >= 0 ? t.count.toLocaleString() : '—'}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Visualisez la taille de chaque table</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
