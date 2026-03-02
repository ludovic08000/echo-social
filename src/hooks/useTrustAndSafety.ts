import { useQuery, useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export function useTrustScore(userId: string | undefined) {
  return useQuery({
    queryKey: ['trust-score', userId],
    queryFn: async () => {
      if (!userId) return null;
      const { data, error } = await supabase
        .from('trust_scores')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!userId,
  });
}

export function useComputeTrustScore() {
  return useMutation({
    mutationFn: async (userId: string) => {
      const { data, error } = await supabase.functions.invoke('trust-score', {
        body: { action: 'compute', userId },
      });
      if (error) throw error;
      return data;
    },
  });
}

export function useRateCheck() {
  return useMutation({
    mutationFn: async (actionType: string) => {
      const { data, error } = await supabase.functions.invoke('anti-abuse', {
        body: { action: 'check_rate', actionType },
      });
      if (error) throw error;
      return data as { allowed: boolean; remaining: number; total: number };
    },
  });
}

export function useRegisterFingerprint() {
  return useMutation({
    mutationFn: async (fingerprint: {
      fingerprintHash: string;
      screenResolution?: string;
      timezone?: string;
      language?: string;
    }) => {
      const { data, error } = await supabase.functions.invoke('anti-abuse', {
        body: { action: 'register_fingerprint', ...fingerprint },
      });
      if (error) throw error;
      return data as { registered: boolean; multiAccountDetected: boolean; linkedAccountCount: number };
    },
  });
}

export function useReportUser() {
  return useMutation({
    mutationFn: async (params: {
      reportedUserId: string;
      reportType: string;
      description?: string;
    }) => {
      const { data, error } = await supabase.functions.invoke('anti-abuse', {
        body: { action: 'report_user', ...params },
      });
      if (error) throw error;
      return data;
    },
  });
}

export function useServerFeedScoring() {
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (config: {
      feedAlgorithm?: string;
      diversityBoost?: number;
      mutedKeywords?: string[];
      viralContentReduce?: boolean;
      friendsWeight?: number;
      discoveryWeight?: number;
      limit?: number;
      offset?: number;
    }) => {
      const { data, error } = await supabase.functions.invoke('feed-scoring', {
        body: config,
      });
      if (error) throw error;
      return data as { postIds: string[]; scores: Record<string, { score: number; factors: Record<string, number> }> };
    },
  });
}

// Generate a simple browser fingerprint hash
export function generateFingerprint(): string {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillText('fingerprint', 2, 2);
  }
  
  const components = [
    navigator.userAgent,
    navigator.language,
    screen.width + 'x' + screen.height,
    screen.colorDepth,
    new Date().getTimezoneOffset(),
    navigator.hardwareConcurrency || 'unknown',
    canvas.toDataURL(),
  ];
  
  // Simple hash
  let hash = 0;
  const str = components.join('|');
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}
