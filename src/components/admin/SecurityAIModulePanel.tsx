import { useState } from 'react';
import { Brain, ShieldAlert, Globe, FileSearch, Bug, UserCheck, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAIEngine } from '@/hooks/useAIEngine';

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

  const upsertResult = (id: string, label: string, result: unknown) => {
    setResults(prev => [
      { id, label, result, updatedAt: new Date().toISOString() },
      ...prev.filter(r => r.id !== id),
    ].slice(0, 10));
  };

  const sampleContext = {
    source: 'security-dashboard',
    timeWindow: 'last_10_minutes',
    telemetry: {
      ddosTracker: 'use security-monitor live tables for production telemetry',
      auditLogs: 'server-side only',
      abuseReports: 'server-side only',
    },
  };

  const modules = [
    {
      id: 'intrusion-detector',
      label: 'Intrusion Detector',
      icon: ShieldAlert,
      run: async () => upsertResult('intrusion-detector', 'Intrusion Detector', await detectIntrusion(sampleContext)),
    },
    {
      id: 'ip-analyzer',
      label: 'IP Analyzer',
      icon: Globe,
      run: async () => upsertResult('ip-analyzer', 'IP Analyzer', await analyzeIP(sampleContext)),
    },
    {
      id: 'packet-inspector',
      label: 'Packet Inspector',
      icon: FileSearch,
      run: async () => upsertResult('packet-inspector', 'Packet Inspector', await inspectPacket(sampleContext)),
    },
    {
      id: 'vuln-scanner',
      label: 'Vulnerability Scanner',
      icon: Bug,
      run: async () => upsertResult('vuln-scanner', 'Vulnerability Scanner', await scanVulnerabilities(sampleContext)),
    },
    {
      id: 'session-guardian',
      label: 'Session Guardian',
      icon: UserCheck,
      run: async () => upsertResult('session-guardian', 'Session Guardian', await analyzeSession(sampleContext)),
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Brain className="w-4 h-4 text-primary" />
          Zeus Security AI — modules défensifs
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
              Lance un module pour vérifier que l'AI Engine sécurité répond bien. Les analyses sont défensives et les secrets sont redacted côté Edge Function.
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
