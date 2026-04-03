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
  RefreshCw, AlertTriangle, Bug, Zap, TrendingUp, Mail, Search
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

const STATUS_ICONS: Record<string, typeof ShieldCheck> = {
  safe: ShieldCheck,
  at_risk: ShieldAlert,
  under_attack: AlertTriangle,
};

export function SecurityMonitoringSection() {
  const [search, setSearch] = useState('');
  const queryClient = useQueryClient();

  // Fetch incidents
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

  // Fetch AI patterns
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

  // Fetch alert config
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

  // Run manual scan
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
        description: `${data.incidents_detected} incidents, ${data.local_detections} détections locales, ${data.patterns_learned} patterns appris. ${data.ai_used ? 'IA+Heuristiques' : 'Mode autonome'}`,
      });
      queryClient.invalidateQueries({ queryKey: ['security-incidents'] });
      queryClient.invalidateQueries({ queryKey: ['security-ai-patterns'] });
    },
    onError: (e: any) => toast({ title: 'Erreur scan', description: e.message, variant: 'destructive' }),
  });

  // Stats
  const totalIncidents = incidents?.length || 0;
  const criticalCount = incidents?.filter(i => i.severity === 'critical').length || 0;
  const successfulAttacks = incidents?.filter(i => i.success).length || 0;
  const blockedAttacks = incidents?.filter(i => !i.success).length || 0;
  const patternCount = patterns?.length || 0;

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
          { label: 'Attaques réussies', value: successfulAttacks, icon: Bug, color: successfulAttacks > 0 ? 'text-red-600 bg-red-500/10' : 'text-muted-foreground bg-secondary/50' },
          { label: 'Patterns appris', value: patternCount, icon: Brain, color: 'text-purple-600 bg-purple-500/10' },
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
                  <TableHead>IP</TableHead>
                  <TableHead>Résultat</TableHead>
                  <TableHead>Faille</TableHead>
                  <TableHead>Recommandation IA</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {incidentsLoading ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Chargement...</TableCell></TableRow>
                ) : !filteredIncidents?.length ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    <ShieldCheck className="w-8 h-8 mx-auto mb-2 text-green-500" />
                    Aucun incident détecté. Plateforme sécurisée.
                  </TableCell></TableRow>
                ) : filteredIncidents.slice(0, 50).map((inc) => (
                  <TableRow key={inc.id}>
                    <TableCell>
                      <Badge variant="secondary" className="text-[10px]">{inc.incident_type}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={cn('text-[10px]', SEVERITY_COLORS[inc.severity] || 'bg-secondary')}>
                        {inc.severity}
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
                    <TableCell className="text-xs max-w-[200px]">
                      {inc.vulnerability_found ? (
                        <span className="text-destructive font-medium">{inc.vulnerability_found}</span>
                      ) : '-'}
                    </TableCell>
                    <TableCell className="text-xs max-w-[200px] truncate">{inc.ai_recommendation || '-'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {format(new Date(inc.created_at), 'dd/MM HH:mm', { locale: fr })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* AI Learned Patterns */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Brain className="w-4 h-4 text-purple-500" /> Patterns IA appris (Auto-apprentissage)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!patterns?.length ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              L'IA n'a pas encore appris de patterns. Lancez un scan pour démarrer l'apprentissage.
            </p>
          ) : (
            <div className="space-y-2">
              {patterns.map(p => (
                <div key={p.id} className="flex items-center justify-between p-3 rounded-xl bg-secondary/30 border border-border/50">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{p.pattern_name}</span>
                      <Badge className={cn('text-[10px]', SEVERITY_COLORS[p.severity] || 'bg-secondary')}>{p.severity}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{p.detection_rule}</p>
                  </div>
                  <div className="flex items-center gap-3 ml-3">
                    <div className="text-right">
                      <p className="text-xs font-medium text-foreground">Confiance: {Math.round((p.confidence || 0) * 100)}%</p>
                      <p className="text-[10px] text-muted-foreground">{p.times_matched} détections</p>
                    </div>
                    <div className="w-16 h-2 rounded-full bg-secondary overflow-hidden">
                      <div 
                        className="h-full rounded-full bg-purple-500 transition-all" 
                        style={{ width: `${Math.round((p.confidence || 0) * 100)}%` }} 
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-[10px] text-muted-foreground mt-3 text-center">
            🧠 L'IA analyse chaque incident et crée des patterns exploitables par le moteur local. Plus elle apprend, moins Gemini est nécessaire.
          </p>
        </CardContent>
      </Card>

      {/* Autonomy Progress */}
      {lastScanResult && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" /> Progression vers l'autonomie
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Mode dernier scan :</span>
              <Badge variant={lastScanResult.ai_used ? 'secondary' : 'default'} className="text-[10px]">
                {lastScanResult.ai_used ? '🤖 IA + Heuristiques' : '⚡ 100% Autonome'}
              </Badge>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Détections locales :</span>
              <span className="font-medium text-foreground">{lastScanResult.local_detections}/{lastScanResult.incidents_detected}</span>
            </div>
            {lastScanResult.autonomy_score != null && (
              <div>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="text-muted-foreground">Score d'autonomie :</span>
                  <span className="font-bold text-foreground">{Math.round(lastScanResult.autonomy_score * 100)}%</span>
                </div>
                <div className="w-full h-3 rounded-full bg-secondary overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-primary/70 to-primary transition-all duration-500"
                    style={{ width: `${Math.round(lastScanResult.autonomy_score * 100)}%` }}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {lastScanResult.autonomy_score >= 0.8 ? '🟢 L\'IA locale est quasi-autonome' :
                   lastScanResult.autonomy_score >= 0.5 ? '🟡 Apprentissage en bonne voie' :
                   '🔴 Gemini encore très utilisé — plus de scans nécessaires'}
                </p>
              </div>
            )}
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Patterns totaux :</span>
              <span className="font-medium text-foreground">{lastScanResult.patterns_total || patternCount}</span>
            </div>
            {lastScanResult.self_improvement && (
              <div className="p-3 rounded-lg bg-secondary/30 border border-border/50">
                <p className="text-[10px] font-medium text-muted-foreground mb-1">🧠 Notes d'auto-amélioration :</p>
                <p className="text-xs text-foreground">{lastScanResult.self_improvement}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
