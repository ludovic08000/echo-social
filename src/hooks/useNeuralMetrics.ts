import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface MetricPoint {
  time: string;
  calls: number;
  latency: number;
  errors: number;
  threats: number;
}

export interface TrustScoreData {
  user_id: string;
  trust_score: number;
  flag_reason: string | null;
  name: string;
  city: string | null;
}

export interface FeedConfigEntry {
  key: string;
  value: unknown;
  description: string | null;
  updated_at: string;
}

// Stable seed data generated once per session
let _seedCache: MetricPoint[] | null = null;
function getStableSeedData(): MetricPoint[] {
  if (_seedCache) return _seedCache;
  const now = new Date();
  const points: MetricPoint[] = [];
  // Use hour-based seed for deterministic-ish values
  for (let i = 23; i >= 0; i--) {
    const h = new Date(now.getTime() - i * 3600000);
    const seed = h.getHours() * 137 + h.getDate() * 31;
    points.push({
      time: h.toLocaleTimeString('fr', { hour: '2-digit', minute: '2-digit' }),
      calls: (seed % 400) + 150,
      latency: (seed % 60) + 30,
      errors: seed % 8,
      threats: seed % 20,
    });
  }
  _seedCache = points;
  return points;
}

export function useNeuralMetrics() {
  const { user } = useAuth();
  const [chartData, setChartData] = useState<MetricPoint[]>(getStableSeedData);
  const [loading, setLoading] = useState(true);

  const fetchMetrics = useCallback(async () => {
    try {
      const since = new Date(Date.now() - 24 * 3600000).toISOString();
      const { data } = await supabase
        .from('ai_metrics_log')
        .select('*')
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .limit(500);

      if (!data || data.length === 0) {
        setChartData(getStableSeedData());
        return;
      }

      const buckets: Record<string, { calls: number; latency: number[]; errors: number; threats: number }> = {};
      for (const row of data) {
        const d = new Date(row.created_at);
        const key = d.toLocaleTimeString('fr', { hour: '2-digit', minute: '2-digit' });
        if (!buckets[key]) buckets[key] = { calls: 0, latency: [], errors: 0, threats: 0 };
        buckets[key].calls++;
        buckets[key].latency.push(Number(row.value) || 0);
        if (row.metric_type === 'error') buckets[key].errors++;
        if (row.metric_type === 'threat') buckets[key].threats++;
      }

      const points = Object.entries(buckets).map(([time, b]) => ({
        time,
        calls: b.calls,
        latency: Math.round(b.latency.reduce((a, c) => a + c, 0) / b.latency.length),
        errors: b.errors,
        threats: b.threats,
      }));
      setChartData(points);
    } catch (e) {
      console.error('Failed to fetch metrics:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    // Fallback polling every 30s
    const iv = setInterval(fetchMetrics, 30000);

    // Realtime subscription for instant updates
    const channel = supabase
      .channel('ai-metrics-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'ai_metrics_log' },
        () => fetchMetrics()
      )
      .subscribe();

    return () => {
      clearInterval(iv);
      supabase.removeChannel(channel);
    };
  }, [fetchMetrics]);

  return { chartData, loading, refetch: fetchMetrics };
}

export function useTrustScores() {
  const [scores, setScores] = useState<TrustScoreData[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('trust_scores' as any)
        .select('user_id, trust_score, flag_reason')
        .order('trust_score', { ascending: true })
        .limit(20);

      if (data && data.length > 0) {
        // Enrich with profile names
        const userIds = (data as any[]).map((d: any) => d.user_id);
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, name, city')
          .in('id', userIds);

        const profileMap = new Map((profiles || []).map((p: any) => [p.id, p]));
        setScores((data as any[]).map((d: any) => ({
          ...d,
          name: profileMap.get(d.user_id)?.name || 'Inconnu',
          city: profileMap.get(d.user_id)?.city || null,
        })));
      }
    } catch (e) {
      console.error('Failed to fetch trust scores:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetch(); }, [fetch]);
  return { scores, loading, refetch: fetch };
}

export function useFeedConfig() {
  const [config, setConfig] = useState<FeedConfigEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchConfig = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('feed_algorithm_config')
        .select('*')
        .order('key');
      setConfig((data || []).map((d: any) => ({
        key: d.key,
        value: d.value,
        description: d.description,
        updated_at: d.updated_at,
      })));
    } catch (e) {
      console.error('Failed to fetch feed config:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const updateConfig = useCallback(async (key: string, value: unknown) => {
    const { error } = await supabase
      .from('feed_algorithm_config')
      .update({ value: value as any, updated_at: new Date().toISOString() } as any)
      .eq('key', key);
    if (!error) fetchConfig();
    return !error;
  }, [fetchConfig]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);
  return { config, loading, updateConfig, refetch: fetchConfig };
}
