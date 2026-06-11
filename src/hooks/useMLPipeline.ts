import { useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from '@/hooks/use-toast';

// ── Fraud Detection ──
export function useFraudDetection() {
  const [loading, setLoading] = useState(false);
  const { user } = useAuth();

  const scanUser = useCallback(async (targetUserId?: string) => {
    if (!user) return null;
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('ml-fraud-detect', {
        body: { action: 'scan', target_user_id: targetUserId },
      });
      if (error) throw error;
      return data;
    } catch (e) {
      console.error('Fraud scan error:', e);
      return null;
    } finally {
      setLoading(false);
    }
  }, [user]);

  const batchScan = useCallback(async () => {
    if (!user) return null;
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('ml-fraud-detect', {
        body: { action: 'batch_scan' },
      });
      if (error) throw error;
      return data;
    } catch (e) {
      console.error('Batch fraud scan error:', e);
      toast({ title: 'Erreur', description: 'Scan batch échoué', variant: 'destructive' });
      return null;
    } finally {
      setLoading(false);
    }
  }, [user]);

  return { scanUser, batchScan, loading };
}

// ── ML Matching ──
export function useMLMatching() {
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const { user } = useAuth();

  const fetchSuggestions = useCallback(async (limit = 20) => {
    if (!user) return [];
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('ml-matching', {
        body: { action: 'suggest', limit },
      });
      if (error) throw error;
      const results = data?.suggestions || [];
      setSuggestions(results);
      return results;
    } catch (e) {
      console.error('ML Matching error:', e);
      return [];
    } finally {
      setLoading(false);
    }
  }, [user]);

  return { suggestions, fetchSuggestions, loading };
}

// ── ML Moderation ──
export function useMLModeration() {
  const [loading, setLoading] = useState(false);

  const moderate = useCallback(async (text: string, postId?: string) => {
    if (!text || text.trim().length < 3) {
      return { safe: true, action: 'allow', confidence: 1 };
    }
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('ml-moderation', {
        body: { action: 'moderate', text, post_id: postId },
      });
      if (error) throw error;
      return data;
    } catch (e) {
      console.error('ML Moderation error:', e);
      return { safe: true, action: 'allow', confidence: 0 };
    } finally {
      setLoading(false);
    }
  }, []);

  const submitFeedback = useCallback(async (feedback: {
    prediction_id?: string;
    original_label: string;
    corrected_label: string;
    reason?: string;
  }) => {
    try {
      const { data, error } = await supabase.functions.invoke('ml-moderation', {
        body: { action: 'feedback', feedback },
      });
      if (error) throw error;
      toast({ title: '✨ Feedback enregistré', description: 'Le modèle ML va s\'améliorer.' });
      return data;
    } catch (e) {
      console.error('Feedback error:', e);
      return null;
    }
  }, []);

  const getMetrics = useCallback(async () => {
    try {
      const { data, error } = await supabase.functions.invoke('ml-moderation', {
        body: { action: 'metrics' },
      });
      if (error) throw error;
      return data;
    } catch (e) {
      console.error('Metrics error:', e);
      return null;
    }
  }, []);

  return { moderate, submitFeedback, getMetrics, loading };
}
