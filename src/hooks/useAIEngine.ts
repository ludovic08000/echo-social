import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { trackAICall } from '@/lib/ml/aiEngine';
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

export interface IntrusionDetectionResult {
  threat_detected: boolean;
  severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
  attack_types: string[];
  confidence: number;
  evidence: string[];
  recommended_actions: string[];
  should_create_incident: boolean;
  cooldown_seconds: number;
}

export interface IpAnalysisResult {
  risk_level: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  risk_score: number;
  signals: string[];
  likely_actor: 'human' | 'bot' | 'scanner' | 'unknown';
  recommended_rate_limit: string;
  block_recommended: boolean;
  review_required: boolean;
}

export interface PacketInspectionResult {
  malicious: boolean;
  severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
  patterns: string[];
  safe_summary: string;
  recommended_actions: string[];
}

export interface VulnerabilityScanResult {
  findings: Array<{
    severity: 'low' | 'medium' | 'high' | 'critical';
    title: string;
    description: string;
    fix: string;
  }>;
  overall_risk: 'low' | 'medium' | 'high' | 'critical';
  priority_order: string[];
}

export interface SessionAnalysisResult {
  session_risk: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  risk_score: number;
  anomalies: string[];
  recommended_actions: Array<'allow' | 'step_up_auth' | 'refresh_session' | 'revoke_session' | 'notify_user' | 'lock_account_review'>;
  device_trust_delta: number;
  requires_user_notification: boolean;
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
      let { data, error } = await supabase.functions.invoke('ai-engine', {
        body: { action, ...body },
      });

      if (error && (error.message?.includes('401') || error.message?.includes('auth') || error.message?.includes('Non authentifié'))) {
        const { error: refreshErr } = await supabase.auth.refreshSession();
        if (!refreshErr) {
          const retry = await supabase.functions.invoke('ai-engine', {
            body: { action, ...body },
          });
          data = retry.data;
          error = retry.error;
        }
      }

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

  const moderate = useCallback(async (text: string): Promise<ModerationResult | null> => {
    if (!text || text.trim().length < 3) {
      return { safe: true, score: 0, categories: [], sentiment: 'neutral', emotion: 'trust', confidence: 100, suggestion: '', auto_action: 'allow' };
    }
    if (text.trim().length < 15) {
      return { safe: true, score: 0, categories: [], sentiment: 'neutral', emotion: 'trust', confidence: 80, suggestion: '', auto_action: 'allow' };
    }
    return callEngine<ModerationResult>('moderate', 'ai-moderator', { text });
  }, [callEngine]);

  const analyzeSentiment = useCallback(async (text: string): Promise<SentimentResult | null> => {
    if (!text) return null;
    return callEngine<SentimentResult>('analyze_sentiment', 'sentiment-analyzer', { text });
  }, [callEngine]);

  const getRecommendations = useCallback(async (context: Record<string, unknown>): Promise<RecommendResult | null> => {
    return callEngine<RecommendResult>('recommend', 'recommendation-engine', { context });
  }, [callEngine]);

  const getSmartReplies = useCallback(async (text: string): Promise<SmartReplyResult | null> => {
    if (!text) return null;
    return callEngine<SmartReplyResult>('smart_reply', 'smart-reply', { text });
  }, [callEngine]);

  const enhanceContent = useCallback(async (text: string): Promise<ContentEnhanceResult | null> => {
    if (!text) return null;
    return callEngine<ContentEnhanceResult>('content_enhance', 'content-enhancer', { text });
  }, [callEngine]);

  const detectIntrusion = useCallback(async (context: Record<string, unknown>): Promise<IntrusionDetectionResult | null> => {
    return callEngine<IntrusionDetectionResult>('detect_intrusion', 'intrusion-detector', { context });
  }, [callEngine]);

  const analyzeIP = useCallback(async (context: Record<string, unknown>): Promise<IpAnalysisResult | null> => {
    return callEngine<IpAnalysisResult>('analyze_ip', 'ip-analyzer', { context });
  }, [callEngine]);

  const inspectPacket = useCallback(async (context: Record<string, unknown>): Promise<PacketInspectionResult | null> => {
    return callEngine<PacketInspectionResult>('inspect_packet', 'packet-inspector', { context });
  }, [callEngine]);

  const scanVulnerabilities = useCallback(async (context: Record<string, unknown>): Promise<VulnerabilityScanResult | null> => {
    return callEngine<VulnerabilityScanResult>('scan_vulnerabilities', 'vuln-scanner', { context });
  }, [callEngine]);

  const analyzeSession = useCallback(async (context: Record<string, unknown>): Promise<SessionAnalysisResult | null> => {
    return callEngine<SessionAnalysisResult>('analyze_session', 'session-guardian', { context });
  }, [callEngine]);

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
      loadFeedbackHistory();
    }
  }, [callEngine, user?.id]);

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
    detectIntrusion,
    analyzeIP,
    inspectPacket,
    scanVulnerabilities,
    analyzeSession,
    loadFeedbackHistory,
    loading,
    feedbackHistory,
    learnedRules,
  };
}
