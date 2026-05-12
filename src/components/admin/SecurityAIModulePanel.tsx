import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Brain, ShieldAlert, Globe, FileSearch, Bug, UserCheck, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAIEngine } from '@/hooks/useAIEngine';
import { supabase } from '@/integrations/supabase/client';

interface ModuleResult {
  id: string;
  label: string;
  result: unknown;
  updatedAt: string;
}

function severityOf(result: any): string {
  return result?.severity || result?.risk_level || result?.session_risk || result?.overall_risk || 'unknown';
}

function badgeClass(level: string) {
  if (level === 'critical') return 'bg-red-600 text-white';
  if (level === 'high') return 'bg-orange-500 text-white';
  if (level === 'medium') return 'bg-amber-500 text-white';
  if (level === 'low') return 'bg-blue-500 text-white';
  if (level === 'safe' || level === 'none') return 'bg-green-500/10 text-green-600';
  return 'bg-secondary text-secondary-foreground';
}

function compactRows(rows: any[] | undefined, fields: string[]) {
  return (rows || []).slice(0, 50).map(row => {
    const out: Record<string, unknown> = {};
    for (const field of fields) out[field] = row?.[field];
    return out;
  });
}

export function SecurityAIModulePanel() {
  const {
    detectIntrusion,
    analyzeIP,
    inspectPacket,
    scanVulnerabilities,
    analyzeSession,
    loading,
  } = useAIEngine();
  const [results, setResults] = useState<ModuleResult[]>([]);

  const { data: ddosTracker } = useQuery({
    queryKey: ['security-ai-live-ddos'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ddos_ip_tracker')
        .select('ip_address, endpoint, request_count, penalty_level, blocked_until, updated_at')
        .order('updated_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data || [];
    },
    refetchInterval: 10000,
  });

  const { data: incidents } = useQuery({
    queryKey: ['security-ai-live-incidents'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('security_incidents')
        .select('incident_type, severity, status, source_ip, target_endpoint, attack_vector, success, confidence_score, autonomy_level, detection_source, created_at')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data || [];
    },
    refetchInterval: 10000,
  });

  const { data: patterns } = useQuery({
    queryKey: ['security-ai-live-patterns'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('security_ai_patterns')
        .select('pattern_name, severity, confidence, times_matched, autonomy_level, last_matched_at')
        .eq('is_active', true)
        .order('confidence', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    },
    refetchInterval: 15000,
  });

  const { data: qualityMetrics } = useQuery({
    queryKey: ['security-ai-live-quality'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('security_quality_metrics' as any)
        .select('autonomy_score, reaction_time_ms, incidents_detected, ai_calls, created_at')
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data || [];
    },
    refetchInterval: 15000,
  });

  const liveContext = useMemo(() => {
    const dangerousIps = (ddosTracker || []).filter((ip: any) =>
      Number(ip.penalty_level || 0) >= 2 ||
      (ip.blocked_until && new Date(ip.blocked_until) > new Date())
    );
    const criticalIncidents = (incidents || []).filter((i: any) => i.severity === 'critical' || i.severity === 'high');

    return {
      source: 'security-dashboard-live',
      timeWindow: 'latest_runtime_snapshot',
      generatedAt: new Date().toISOString(),
      summary: {
        trackedIpCount: ddosTracker?.length || 0,
        dangerousIpCount: dangerousIps.length,
        incidentCount: incidents?.length || 0,
        criticalIncidentCount: criticalIncidents.length,
        learnedPatternCount: patterns?.length || 0,
        recentMetricCount: qualityMetrics?.length || 0,
      },
      telemetry: {
        ddosTracker: compactRows(ddosTracker, ['ip_address', 'endpoint', 'request_count', 'penalty_level', 'blocked_until', 'updated_at']),
        incidents: compactRows(incidents, ['incident_type', 'severity', 'status', 'source_ip', 'target_endpoint', 'attack_vector', 'success', 'confidence_score', 'autonomy_level', 'detection_source', 'created_at']),
        securityPatterns: compactRows(patterns, ['pattern_name', 'severity', 'confidence', 'times_matched', 'autonomy_level', 'last_matched_at']),
        qualityMetrics: compactRows(qualityMetrics as any[], ['autonomy_score', 'reaction_time_ms', 'incidents_detected', 'ai_calls', 'created_at']),
      },
    };
  }, [ddosTracker, incidents, patterns, qualityMetrics]);

  const upsertResult = (id: string, label: string, result: unknown) => {
    setResults(prev => [
      { id, label, result, updatedAt: new Date().toISOString() },
      ...prev.filter(r => r.id !== id),
    ].slice(0, 10));
  };

  const modules = [
    {
      id: 'intrusion-detector',
      label: 'Intrusion Detector',
      icon: ShieldAlert,
      run: async () => upsertResult('intrusion-detector', 'Intrusion Detector', await detectIntrusion(liveContext)),
    },
    {
      id: 'ip-analyzer',
      label: 'IP Analyzer',
      icon: Globe,
      run: async () => upsertResult('ip-analyzer', 'IP Analyzer', await analyzeIP(liveContext)),
    },
    {
      id: 'packet-inspector',
      label: 'Packet Inspector',
      icon: FileSearch,
      run: async () => upsertResult('packet-inspector', 'Packet Inspector', await inspectPacket(liveContext)),
    },
    {
      id: 'vuln-scanner',
      label: 'Vulnerability Scanner',
      icon: Bug,
      run: async () => upsertResult('vuln-scanner', 'Vulnerability Scanner', await scanVulnerabilities(liveContext)),
    },
    {
      id: 'session-guardian',
      label: 'Session Guardian',
      icon: UserCheck,
      run: async () => upsertResult('session-guardian', 'Session Guardian', await analyzeSession(liveContext)),
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Brain className="w-4 h-4 text-primary" />
          Zeus Security AI — modules défensifs
          <Badge variant="secondary" className="text-[10px]">
            {liveContext.summary.trackedIpCount} IP / {liveContext.summary.incidentCount} incidents
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-2">
          {modules.map((m) => {
            const Icon = m.icon;
            const isLoading = !!loading[m.id];
            return (
              <Button
                key={m.id}
                variant="outline"
                size="sm"
                onClick={() => void m.run()}
                disabled={isLoading}
                className="justify-start gap-2"
              >
                {isLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
                {m.label}
              </Button>
            );
          })}
        </div>

        <div className="space-y-2">
          {results.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Lance un module pour analyser les données live du SOC : IP tracker, incidents, patterns appris et métriques IA. Les analyses restent défensives et les secrets sont filtrés côté Edge Function.
            </p>
          ) : results.map((r) => {
            const result = r.result as any;
            const sev = severityOf(result);
            return (
              <div key={`${r.id}-${r.updatedAt}`} className="rounded-xl border p-3 text-xs space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{r.label}</span>
                  <Badge className={badgeClass(sev)}>{sev}</Badge>
                </div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
                  {JSON.stringify(result, null, 2)}
                </pre>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
