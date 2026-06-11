import { useState, useEffect, useCallback } from 'react';
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
  Target, Timer, Gauge, BarChart3, Wifi, WifiOff, Globe, Ban
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { SecurityAIModulePanel } from './SecurityAIModulePanel';

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

const ENDPOINT_LABELS: Record<string, string> = {
  'anti-abuse': '🛡️ Anti-abus',
  'verify-chat-pin': '🔐 PIN Chat',
  'ai-engine': '🧠 IA Engine',
  'agent-chat': '💬 Agent Chat',
  'image-optimize': '🖼️ Optimisation',
  'global': '🌐 Global',
};

interface ZeusAlert {
  id: string;
  message: string;
  severity: 'critical' | 'high' | 'medium';
  ip: string | null;
  endpoint: string | null;
  timestamp: Date;
}

export function SecurityMonitoringSection() {
  const [search, setSearch] = useState('');
  const [ipSearch, setIpSearch] = useState('');
  const [zeusAlerts, setZeusAlerts] = useState<ZeusAlert[]>([]);
  const [isRealtime, setIsRealtime] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [prevIncidentCount, setPrevIncidentCount] = useState(0);
  const [lastScanResult, setLastScanResult] = useState<any>(null);
  const queryClient = useQueryClient();

  // ── Incidents (temps réel 5s) ──
  const { data: incidents, isLoading: incidentsLoading } = useQuery({
    queryKey: ['security-incidents'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('security_incidents')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data;
    },
    refetchInterval: isRealtime ? 5000 : false,
  });

  // ── TOUTES les IPs du tracker DDoS (temps réel 5s) ──
  const { data: allIps } = useQuery({
    queryKey: ['ddos-ip-tracker-all'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ddos_ip_tracker')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      setLastRefresh(new Date());
      return data;
    },
    refetchInterval: isRealtime ? 5000 : false,
  });

  // ── IPs bannies ──
  const { data: bannedIps } = useQuery({
    queryKey: ['banned-ips-monitor'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('banned_ips')
        .select('*')
        .eq('is_active', true)
        .order('banned_at', { ascending: false });
      if (error) throw error;
      return data;
    },
    refetchInterval: isRealtime ? 10000 : false,
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
    refetchInterval: isRealtime ? 15000 : false,
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

  useEffect(() => {
    if (!incidents) return;
    const currentCount = incidents.length;
    
    if (prevIncidentCount > 0 && currentCount > prevIncidentCount) {
      const newIncidents = incidents.slice(0, currentCount - prevIncidentCount);
      const criticals = newIncidents.filter((i: any) => i.severity === 'critical' || i.severity === 'high');
      
      criticals.forEach((inc: any) => {
        const endpoint = inc.target_endpoint || inc.attack_vector || 'inconnu';
        const ip = inc.source_ip || 'IP masquée';
        const alert: ZeusAlert = {
          id: inc.id,
          message: `⚡ ZEUS ALERTE : Attaque ${inc.severity.toUpperCase()} détectée — ${inc.incident_type} depuis ${ip} ciblant ${endpoint}`,
          severity: inc.severity,
          ip: inc.source_ip,
          endpoint: inc.target_endpoint,
          timestamp: new Date(inc.created_at),
        };
        setZeusAlerts(prev => [alert, ...prev].slice(0, 10));
        
        toast({
          title: `⚡ Zeus — ${inc.severity === 'critical' ? '🔴 CRITIQUE' : '🟠 HAUTE'} sévérité`,
          description: `${inc.incident_type} depuis ${ip} → ${endpoint}. ${inc.success ? '⚠️ Attaque réussie !' : '✅ Bloquée.'}`,
          variant: 'destructive',
          duration: 15000,
        });
      });
    }
    setPrevIncidentCount(currentCount);
  }, [incidents]);

  // ── Détection anomalies IP en temps réel ──
  useEffect(() => {
    if (!allIps) return;
    const dangerousIps = allIps.filter((ip: any) => 
      ip.penalty_level >= 3 || 
      (ip.blocked_until && new Date(ip.blocked_until) > new Date())
    );
    
    dangerousIps.forEach((ip: any) => {
      const existing = zeusAlerts.find(a => a.ip === ip.ip_address);
      if (!existing && ip.penalty_level >= 3) {
        const alert: ZeusAlert = {
          id: `ip-${ip.id}`,
          message: `🚨 IP ${ip.ip_address} — Niveau de pénalité ${ip.penalty_level} sur endpoint ${ENDPOINT_LABELS[ip.endpoint] || ip.endpoint}. ${ip.request_count} requêtes détectées.`,
          severity: ip.penalty_level >= 4 ? 'critical' : 'high',
          ip: ip.ip_address,
          endpoint: ip.endpoint,
          timestamp: new Date(ip.updated_at),
        };
        setZeusAlerts(prev => [alert, ...prev].slice(0, 10));
      }
    });
  }, [allIps]);

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
      queryClient.invalidateQueries({ queryKey: ['ddos-ip-tracker-all'] });
      queryClient.invalidateQueries({ queryKey: ['security-ai-patterns'] });
      queryClient.invalidateQueries({ queryKey: ['security-quality-metrics'] });
    },
    onError: (e: any) => toast({ title: 'Erreur scan', description: e.message, variant: 'destructive' }),
  });

  // Stats
  const totalIncidents = incidents?.length || 0;
  const criticalCount = incidents?.filter((i: any) => i.severity === 'critical').length || 0;
  const successfulAttacks = incidents?.filter((i: any) => i.success).length || 0;
  const blockedAttacks = incidents?.filter((i: any) => !i.success).length || 0;
  const patternCount = patterns?.length || 0;
  const totalTrackedIps = allIps?.length || 0;
  const blockedIpCount = allIps?.filter((ip: any) => ip.blocked_until && new Date(ip.blocked_until) > new Date()).length || 0;

  const recentMetrics = qualityMetrics?.slice(0, 10) || [];
  const avgAutonomy = recentMetrics.length > 0 
    ? recentMetrics.reduce((s: number, m: any) => s + Number(m.autonomy_score || 0), 0) / recentMetrics.length 
    : 0;
  const avgReactionTime = recentMetrics.length > 0
    ? Math.round(recentMetrics.reduce((s: number, m: any) => s + (m.reaction_time_ms || 0), 0) / recentMetrics.length)
    : 0;

  const platformHealth = criticalCount > 0 ? 'under_attack' : successfulAttacks > 0 ? 'at_risk' : 'safe';
  const HealthIcon = STATUS_ICONS[platformHealth] || ShieldCheck;

  const filteredIncidents = incidents?.filter((i: any) =>
    !search.trim() ||
    i.incident_type?.toLowerCase().includes(search.toLowerCase()) ||
    i.source_ip?.toLowerCase().includes(search.toLowerCase()) ||
    i.attack_vector?.toLowerCase().includes(search.toLowerCase())
  );

  const filteredIps = allIps?.filter((ip: any) =>
    !ipSearch.trim() ||
    ip.ip_address?.includes(ipSearch) ||
    ip.endpoint?.toLowerCase().includes(ipSearch.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Header avec indicateur temps réel */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
          <Shield className="w-5 h-5 text-primary" />
          IA Security Monitoring
        </h2>
        <div className="flex items-center gap-2">
          <Button
            variant={isRealtime ? 'default' : 'outline'}
            size="sm"
            onClick={() => setIsRealtime(!isRealtime)}
            className="gap-1.5"
          >
            {isRealtime ? <Wifi className="w-3.5 h-3.5 animate-pulse" /> : <WifiOff className="w-3.5 h-3.5" />}
            {isRealtime ? 'Temps réel' : 'Pausé'}
          </Button>
          <Button onClick={() => runScan.mutate()} disabled={runScan.isPending} size="sm">
            {runScan.isPending ? <RefreshCw className="w-4 h-4 animate-spin mr-1" /> : <Zap className="w-4 h-4 mr-1" />}
            Scan complet
          </Button>
        </div>
      </div>

      {/* Zeus Alertes en temps réel */}
      <AnimatePresence>
        {zeusAlerts.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-2"
          >
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-500" />
              ⚡ Zeus — Alertes de sécurité en direct
            </h3>
            {zeusAlerts.slice(0, 5).map((alert, i) => (
              <motion.div
                key={alert.id}
                initial={{ opacity: 0, x: -30 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.05 }}
                className={cn(
                  'p-3 rounded-xl border text-sm flex items-start gap-3',
                  alert.severity === 'critical' 
                    ? 'bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-300' 
                    : 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300'
                )}
              >
                <AlertTriangle className={cn('w-4 h-4 mt-0.5 shrink-0', alert.severity === 'critical' ? 'text-red-500 animate-pulse' : 'text-amber-500')} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium">{alert.message}</p>
                  <div className="flex items-center gap-3 mt-1">
                    {alert.ip && (
                      <span className="text-[10px] font-mono bg-black/10 dark:bg-white/10 px-1.5 py-0.5 rounded">
                        IP: {alert.ip}
                      </span>
                    )}
                    {alert.endpoint && (
                      <span className="text-[10px]">
                        Cible: {ENDPOINT_LABELS[alert.endpoint] || alert.endpoint}
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      {formatDistanceToNow(alert.timestamp, { addSuffix: true, locale: fr })}
                    </span>
                  </div>
                </div>
              </motion.div>
            ))}
            {zeusAlerts.length > 5 && (
              <p className="text-[10px] text-muted-foreground text-center">
                +{zeusAlerts.length - 5} alertes supplémentaires
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Health & Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        {[
          { label: 'Santé plateforme', value: platformHealth === 'safe' ? '✅ Sûre' : platformHealth === 'at_risk' ? '⚠️ À risque' : '🔴 Attaque', icon: HealthIcon, color: platformHealth === 'safe' ? 'text-green-600 bg-green-500/10' : platformHealth === 'at_risk' ? 'text-amber-600 bg-amber-500/10' : 'text-red-600 bg-red-500/10' },
          { label: 'Incidents', value: totalIncidents, icon: Activity, color: 'text-blue-600 bg-blue-500/10' },
          { label: 'Bloquées', value: blockedAttacks, icon: ShieldCheck, color: 'text-green-600 bg-green-500/10' },
          { label: 'IPs trackées', value: totalTrackedIps, icon: Globe, color: 'text-purple-600 bg-purple-500/10' },
          { label: 'IPs bloquées', value: blockedIpCount, icon: Ban, color: 'text-red-600 bg-red-500/10' },
          { label: 'Autonomie', value: `${Math.round(avgAutonomy * 100)}%`, icon: Gauge, color: 'text-primary bg-primary/10' },
        ].map((card, i) => (
          <motion.div key={card.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <Card>
              <CardContent className="p-3">
                <div className="flex items-center gap-2">
                  <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center shrink-0', card.color)}>
                    <card.icon className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-base font-bold text-foreground">{card.value}</p>
                    <p className="text-[9px] text-muted-foreground truncate">{card.label}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Zeus Security AI — modules défensifs */}
      <SecurityAIModulePanel />

      {/* ═══ TABLEAU DES IPs EN CLAIR ═══ */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Globe className="w-4 h-4 text-primary" />
              Moniteur IP — Toutes les connexions ({totalTrackedIps})
              {isRealtime && (
                <span className="flex items-center gap-1 text-[10px] text-green-500 font-normal">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                  Live
                </span>
              )}
            </CardTitle>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">
                MAJ: {format(lastRefresh, 'HH:mm:ss', { locale: fr })}
              </span>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input placeholder="Filtrer IP..." value={ipSearch} onChange={e => setIpSearch(e.target.value)} className="pl-7 h-8 w-40 text-xs" />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-border overflow-hidden max-h-[400px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Adresse IP</TableHead>
                  <TableHead className="text-xs">Endpoint ciblé</TableHead>
                  <TableHead className="text-xs">Requêtes</TableHead>
                  <TableHead className="text-xs">Pénalité</TableHead>
                  <TableHead className="text-xs">Statut</TableHead>
                  <TableHead className="text-xs">Bloquée jusqu'à</TableHead>
                  <TableHead className="text-xs">Dernière activité</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!filteredIps?.length ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-6 text-muted-foreground text-sm">
                      <ShieldCheck className="w-6 h-6 mx-auto mb-1 text-green-500" />
                      Aucune IP trackée
                    </TableCell>
                  </TableRow>
                ) : filteredIps.map((ip: any) => {
                  const isBlocked = ip.blocked_until && new Date(ip.blocked_until) > new Date();
                  const isDangerous = ip.penalty_level >= 3;
                  const isWarning = ip.penalty_level >= 1;
                  return (
                    <TableRow key={ip.id} className={cn(
                      isDangerous ? 'bg-red-500/5' : isBlocked ? 'bg-amber-500/5' : ''
                    )}>
                      <TableCell className="font-mono text-xs font-medium">
                        <div className="flex items-center gap-1.5">
                          {isDangerous && <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />}
                          {isBlocked && !isDangerous && <span className="w-2 h-2 rounded-full bg-amber-500" />}
                          {ip.ip_address}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <Badge variant="secondary" className="text-[10px]">
                          {ENDPOINT_LABELS[ip.endpoint] || ip.endpoint}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs font-medium">
                        <span className={cn(ip.request_count > 50 ? 'text-red-500' : ip.request_count > 10 ? 'text-amber-500' : 'text-foreground')}>
                          {ip.request_count}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge className={cn('text-[10px]', 
                          ip.penalty_level >= 4 ? 'bg-red-600 text-white' :
                          ip.penalty_level >= 2 ? 'bg-orange-500 text-white' :
                          ip.penalty_level >= 1 ? 'bg-amber-500 text-white' :
                          'bg-secondary text-secondary-foreground'
                        )}>
                          Niv. {ip.penalty_level}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {isBlocked ? (
                          <Badge variant="destructive" className="text-[10px]">🔒 Bloquée</Badge>
                        ) : isDangerous ? (
                          <Badge className="bg-red-500/10 text-red-600 text-[10px]">⚠️ Dangereuse</Badge>
                        ) : isWarning ? (
                          <Badge className="bg-amber-500/10 text-amber-600 text-[10px]">👁️ Surveillée</Badge>
                        ) : (
                          <Badge className="bg-green-500/10 text-green-600 text-[10px]">✅ OK</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {isBlocked ? format(new Date(ip.blocked_until), 'dd/MM HH:mm', { locale: fr }) : '—'}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(ip.updated_at), { addSuffix: true, locale: fr })}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* IPs bannies actives */}
      {bannedIps && bannedIps.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Ban className="w-4 h-4 text-red-500" /> IPs bannies actives ({bannedIps.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              {bannedIps.map((ip: any) => (
                <div key={ip.id} className="flex items-center justify-between p-2.5 rounded-lg bg-red-500/5 border border-red-500/10 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs font-bold text-red-600">{ip.ip_address}</span>
                    <span className="text-xs text-muted-foreground">{ip.reason || 'Auto-ban'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {ip.expires_at && (
                      <span className="text-[10px] text-muted-foreground">
                        Expire: {format(new Date(ip.expires_at), 'dd/MM HH:mm', { locale: fr })}
                      </span>
                    )}
                    <Badge variant="destructive" className="text-[10px]">Bannie</Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quality Metrics */}
      {recentMetrics.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-primary" /> Métriques IA
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
              <div className="p-3 rounded-xl bg-secondary/30 border border-border/50 text-center">
                <Target className="w-5 h-5 mx-auto mb-1 text-green-500" />
                <p className="text-lg font-bold text-foreground">{Math.round(avgAutonomy * 100)}%</p>
                <p className="text-[10px] text-muted-foreground">Autonomie</p>
              </div>
              <div className="p-3 rounded-xl bg-secondary/30 border border-border/50 text-center">
                <Timer className="w-5 h-5 mx-auto mb-1 text-blue-500" />
                <p className="text-lg font-bold text-foreground">{avgReactionTime}ms</p>
                <p className="text-[10px] text-muted-foreground">Réaction moy.</p>
              </div>
              <div className="p-3 rounded-xl bg-secondary/30 border border-border/50 text-center">
                <Brain className="w-5 h-5 mx-auto mb-1 text-purple-500" />
                <p className="text-lg font-bold text-foreground">{patternCount}</p>
                <p className="text-[10px] text-muted-foreground">Patterns appris</p>
              </div>
              <div className="p-3 rounded-xl bg-secondary/30 border border-border/50 text-center">
                <Zap className="w-5 h-5 mx-auto mb-1 text-amber-500" />
                <p className="text-lg font-bold text-foreground">{recentMetrics.length}</p>
                <p className="text-[10px] text-muted-foreground">Scans récents</p>
              </div>
            </div>
            <div className="flex gap-1 items-end h-12">
              {recentMetrics.slice().reverse().map((m: any, i: number) => {
                const score = Number(m.autonomy_score || 0);
                return (
                  <div
                    key={i}
                    className={cn(
                      "flex-1 rounded-t transition-all",
                      score >= 0.8 ? "bg-green-500" : score >= 0.5 ? "bg-amber-500" : "bg-red-500"
                    )}
                    style={{ height: `${Math.max(4, score * 48)}px` }}
                    title={`Scan ${i + 1}: ${Math.round(score * 100)}%`}
                  />
                );
              })}
            </div>
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
              <AlertTriangle className="w-4 h-4" /> Incidents ({totalIncidents})
            </CardTitle>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input placeholder="Filtrer..." value={search} onChange={e => setSearch(e.target.value)} className="pl-7 h-8 w-48 text-xs" />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-border overflow-hidden max-h-[400px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Type</TableHead>
                  <TableHead className="text-xs">Sévérité</TableHead>
                  <TableHead className="text-xs">Confiance</TableHead>
                  <TableHead className="text-xs">Niveau</TableHead>
                  <TableHead className="text-xs">IP source</TableHead>
                  <TableHead className="text-xs">Cible</TableHead>
                  <TableHead className="text-xs">Résultat</TableHead>
                  <TableHead className="text-xs">Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {incidentsLoading ? (
                  <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Chargement...</TableCell></TableRow>
                ) : !filteredIncidents?.length ? (
                  <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    <ShieldCheck className="w-8 h-8 mx-auto mb-2 text-green-500" />
                    Aucun incident.
                  </TableCell></TableRow>
                ) : filteredIncidents.slice(0, 100).map((inc: any) => {
                  const confScore = Number(inc.confidence_score || 0);
                  const autoLevel = inc.autonomy_level || 1;
                  const levelInfo = AUTONOMY_LABELS[autoLevel] || AUTONOMY_LABELS[1];
                  return (
                    <TableRow key={inc.id} className={cn(inc.severity === 'critical' ? 'bg-red-500/5' : '')}>
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
                      <TableCell className="font-mono text-xs font-medium">{inc.source_ip || '—'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{inc.target_endpoint || inc.attack_vector || '—'}</TableCell>
                      <TableCell>
                        {inc.success ? (
                          <Badge variant="destructive" className="text-[10px]">⚠️ Réussie</Badge>
                        ) : (
                          <Badge className="bg-green-500/10 text-green-600 text-[10px]">✅ Bloquée</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {format(new Date(inc.created_at), 'dd/MM HH:mm:ss', { locale: fr })}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* AI Patterns */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Brain className="w-4 h-4 text-purple-500" /> Patterns IA — Autonomie progressive
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!patterns?.length ? (
            <p className="text-sm text-muted-foreground text-center py-4">Lancez un scan pour démarrer l'apprentissage.</p>
          ) : (
            <div className="space-y-2">
              {patterns.map((p: any) => {
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