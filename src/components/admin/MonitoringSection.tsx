import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Activity, Wifi, Clock, AlertTriangle, TrendingUp, TrendingDown } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { motion } from 'framer-motion';

interface PingResult {
  latency: number;
  status: 'ok' | 'slow' | 'error';
  timestamp: number;
}

export function MonitoringSection() {
  const [pings, setPings] = useState<PingResult[]>([]);
  const [isLive, setIsLive] = useState(true);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const runPing = async (): Promise<PingResult> => {
    const start = performance.now();
    try {
      await supabase.from('profiles').select('user_id', { count: 'exact', head: true }).limit(1);
      const latency = Math.round(performance.now() - start);
      return { latency, status: latency > 2000 ? 'slow' : 'ok', timestamp: Date.now() };
    } catch {
      return { latency: Math.round(performance.now() - start), status: 'error', timestamp: Date.now() };
    }
  };

  useEffect(() => {
    if (!isLive) { if (intervalRef.current) clearInterval(intervalRef.current); return; }
    
    runPing().then(r => setPings(prev => [...prev.slice(-59), r]));
    intervalRef.current = setInterval(async () => {
      const r = await runPing();
      setPings(prev => [...prev.slice(-59), r]);
    }, 10_000);

    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [isLive]);

  const avgLatency = pings.length > 0 ? Math.round(pings.reduce((s, p) => s + p.latency, 0) / pings.length) : 0;
  const errorRate = pings.length > 0 ? Math.round((pings.filter(p => p.status === 'error').length / pings.length) * 100) : 0;
  const p95 = pings.length > 0 ? [...pings].sort((a, b) => a.latency - b.latency)[Math.floor(pings.length * 0.95)]?.latency || 0 : 0;
  const last = pings[pings.length - 1];
  const trend = pings.length >= 5 
    ? (pings.slice(-5).reduce((s, p) => s + p.latency, 0) / 5) - (pings.slice(-10, -5).reduce((s, p) => s + p.latency, 0) / Math.max(pings.slice(-10, -5).length, 1))
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Activity className="w-6 h-6 text-primary" />
          Monitoring temps réel
        </h2>
        <button
          onClick={() => setIsLive(!isLive)}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
            isLive ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30' : 'bg-muted text-muted-foreground border-border'
          }`}
        >
          <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground'}`} />
          {isLive ? 'Live' : 'Pausé'}
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 text-center">
            <Clock className="w-5 h-5 mx-auto mb-1 text-primary" />
            <p className="text-2xl font-bold tabular-nums">{last?.latency || '—'}<span className="text-sm text-muted-foreground">ms</span></p>
            <p className="text-xs text-muted-foreground">Latence actuelle</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 text-center">
            <Wifi className="w-5 h-5 mx-auto mb-1 text-blue-500" />
            <p className="text-2xl font-bold tabular-nums">{avgLatency}<span className="text-sm text-muted-foreground">ms</span></p>
            <p className="text-xs text-muted-foreground">Latence moyenne</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 text-center">
            <AlertTriangle className={`w-5 h-5 mx-auto mb-1 ${errorRate > 0 ? 'text-destructive' : 'text-emerald-500'}`} />
            <p className="text-2xl font-bold tabular-nums">{errorRate}<span className="text-sm text-muted-foreground">%</span></p>
            <p className="text-xs text-muted-foreground">Taux d'erreur</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 text-center">
            {trend > 0 ? <TrendingUp className="w-5 h-5 mx-auto mb-1 text-amber-500" /> : <TrendingDown className="w-5 h-5 mx-auto mb-1 text-emerald-500" />}
            <p className="text-2xl font-bold tabular-nums">{p95}<span className="text-sm text-muted-foreground">ms</span></p>
            <p className="text-xs text-muted-foreground">P95 latence</p>
          </CardContent>
        </Card>
      </div>

      {/* Latency sparkline */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between">
            Historique latence (10 dernières min)
            <Badge variant="secondary" className="text-[10px]">{pings.length} pings</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-[2px] h-20">
            {pings.slice(-60).map((p, i) => {
              const maxLat = Math.max(...pings.map(x => x.latency), 100);
              const h = Math.max((p.latency / maxLat) * 100, 4);
              return (
                <motion.div
                  key={i}
                  initial={{ scaleY: 0 }}
                  animate={{ scaleY: 1 }}
                  className={`flex-1 min-w-[3px] rounded-t origin-bottom transition-colors ${
                    p.status === 'error' ? 'bg-destructive' : p.latency > 1000 ? 'bg-amber-500' : 'bg-primary'
                  }`}
                  style={{ height: `${h}%` }}
                  title={`${p.latency}ms`}
                />
              );
            })}
          </div>
          {pings.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">En attente de données...</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
