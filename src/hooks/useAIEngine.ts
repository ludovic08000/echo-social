import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { trackAICall } from '@/lib/aiEngine';
import { useAuth } from '@/lib/auth';

// ── Types ──
export interface ModerationResult {
  safe: boolean;
  score: number;
  categories: string[];
  sentiment: string;
  emotion: string;
  confidence: number;
  suggestion: string;
  auto_action: 'allow' | 'flag_review' | 'shadow_ban' | 'remove';
}

export interface SentimentResult {
  sentiment: string;
  emotion: string;
  secondary_emotions: string[];
  intensity: number;
  topics: string[];
  engagement_prediction: string;
  virality_score: number;
}

export interface RecommendResult {
  content_types: string[];
  topics: string[];
  time_slots: string[];
  diversity_suggestions: string[];
  fatigue_risk: string;
  personality_type: string;
}

export interface SmartReplyResult {
  replies: string[];
  tone: string;
}

export interface ContentEnhanceResult {
  enhanced: string;
  hashtags: string[];
  improvements: string[];
  readability_before: number;
  readability_after: number;
  engagement_boost_estimate: number;
}

export interface FeedbackEntry {
  id?: string;
  originalText: string;
  aiDecision: string;
  humanDecision: string;
  reason: string;
  created_at?: string;
}

export interface LearnedRule {
  id: string;
  rule: string;
  pattern: string | null;
  created_at: string;
}

// ── Hook ──
export function useAIEngine() {
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [feedbackHistory, setFeedbackHistory] = useState<FeedbackEntry[]>([]);
  const [learnedRules, setLearnedRules] = useState<LearnedRule[]>([]);
  const { user } = useAuth();

  const setModuleLoading = (module: string, val: boolean) => {
    setLoading(prev => ({ ...prev, [module]: val }));
  };

  const callEngine = useCallback(async <T>(action: string, moduleId: string, body: Record<string, unknown>): Promise<T | null> => {
    setModuleLoading(moduleId, true);
    const start = performance.now();
    try {
      // Refresh session to prevent 401 errors
      await supabase.auth.refreshSession();

      const { data, error } = await supabase.functions.invoke('ai-engine', {
        // No user_id sent — the edge function extracts it from the JWT token server-side
        body: { action, ...body },
      });
      const elapsed = Math.round(performance.now() - start);
      const success = !error && !data?.error && data?.result;
      trackAICall(moduleId, elapsed, !!success);

      if (error) throw error;
      if (data?.error) {
        toast({ title: 'IA Engine', description: data.error, variant: 'destructive' });
        return null;
      }
      return data?.result as T;
    } catch (e) {
      trackAICall(moduleId, Math.round(performance.now() - start), false);
      console.error(`AI Engine [${action}] error:`, e);
      toast({ title: 'Erreur IA', description: `Échec du module ${moduleId}`, variant: 'destructive' });
      return null;
    } finally {
      setModuleLoading(moduleId, false);
    }
  }, []);

  // ── Moderation (cache géré côté serveur + skip court côté client) ──
  const moderate = useCallback(async (text: string): Promise<ModerationResult | null> => {
    if (!text || text.trim().length < 3) {
      return { safe: true, score: 0, categories: [], sentiment: 'neutral', emotion: 'trust', confidence: 100, suggestion: '', auto_action: 'allow' };
    }
    // Skip AI call for very short text — too short to be harmful
    if (text.trim().length < 15) {
      return { safe: true, score: 0, categories: [], sentiment: 'neutral', emotion: 'trust', confidence: 80, suggestion: '', auto_action: 'allow' };
    }
    return callEngine<ModerationResult>('moderate', 'ai-moderator', { text });
  }, [callEngine]);

  // ── Sentiment analysis ──
  const analyzeSentiment = useCallback(async (text: string): Promise<SentimentResult | null> => {
    if (!text) return null;
    return callEngine<SentimentResult>('analyze_sentiment', 'sentiment-analyzer', { text });
  }, [callEngine]);

  // ── Recommendations ──
  const getRecommendations = useCallback(async (context: Record<string, unknown>): Promise<RecommendResult | null> => {
    return callEngine<RecommendResult>('recommend', 'recommendation-engine', { context });
  }, [callEngine]);

  // ── Smart replies ──
  const getSmartReplies = useCallback(async (text: string): Promise<SmartReplyResult | null> => {
    if (!text) return null;
    return callEngine<SmartReplyResult>('smart_reply', 'smart-reply', { text });
  }, [callEngine]);

  // ── Content enhancement ──
  const enhanceContent = useCallback(async (text: string): Promise<ContentEnhanceResult | null> => {
    if (!text) return null;
    return callEngine<ContentEnhanceResult>('content_enhance', 'content-enhancer', { text });
  }, [callEngine]);

  // ── Self-learning feedback (stocké en DB) ──
  const submitFeedback = useCallback(async (entry: Omit<FeedbackEntry, 'created_at' | 'id'>) => {
    if (!user?.id) {
      toast({ title: 'Erreur', description: 'Vous devez être connecté pour soumettre un feedback.', variant: 'destructive' });
      return;
    }

    const result = await callEngine<{ new_rules: string[]; pattern: string }>('learn_feedback', 'self-learning', {
      feedback: entry,
    });

    if (result) {
      toast({ title: '✨ IA améliorée', description: 'Le feedback a été intégré au modèle d\'apprentissage côté serveur.' });
      // Refresh history
      loadFeedbackHistory();
    }
  }, [callEngine, user?.id]);

  // ── Load feedback & rules from server ──
  const loadFeedbackHistory = useCallback(async () => {
    if (!user?.id) return;
    const result = await callEngine<{ feedback: FeedbackEntry[]; rules: LearnedRule[] }>(
      'get_feedback_history', 'feedback-loader', { }
    );
    if (result) {
      setFeedbackHistory(result.feedback || []);
      setLearnedRules(result.rules || []);
    }
  }, [callEngine, user?.id]);

  // ── Profile risk assessment ──
  const assessProfileRisk = useCallback(async (context: Record<string, unknown>) => {
    return callEngine<{ risk_level: string; risk_factors: string[]; trust_score: number }>('profile_risk', 'risk-assessor', { context });
  }, [callEngine]);

  return {
    moderate,
    analyzeSentiment,
    getRecommendations,
    getSmartReplies,
    enhanceContent,
    submitFeedback,
    assessProfileRisk,
    loadFeedbackHistory,
    loading,
    feedbackHistory,
    learnedRules,
  };
}
