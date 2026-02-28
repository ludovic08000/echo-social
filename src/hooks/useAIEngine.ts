import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { trackAICall } from '@/lib/aiEngine';

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
  originalText: string;
  aiDecision: string;
  humanDecision: string;
  reason: string;
  timestamp: string;
}

// ── Self-learning store ──
const FEEDBACK_KEY = 'forsure-ai-feedback';
const MODERATION_CACHE_KEY = 'forsure-ai-mod-cache';
const LEARNED_RULES_KEY = 'forsure-ai-learned-rules';

function loadFeedback(): FeedbackEntry[] {
  try { return JSON.parse(localStorage.getItem(FEEDBACK_KEY) || '[]'); } catch { return []; }
}

function saveFeedback(entries: FeedbackEntry[]) {
  // Keep last 200 entries
  localStorage.setItem(FEEDBACK_KEY, JSON.stringify(entries.slice(-200)));
}

function loadLearnedRules(): string[] {
  try { return JSON.parse(localStorage.getItem(LEARNED_RULES_KEY) || '[]'); } catch { return []; }
}

function saveLearnedRules(rules: string[]) {
  localStorage.setItem(LEARNED_RULES_KEY, JSON.stringify(rules.slice(-50)));
}

// Simple content hash for cache
function hashContent(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function getCachedModeration(text: string): ModerationResult | null {
  try {
    const cache = JSON.parse(localStorage.getItem(MODERATION_CACHE_KEY) || '{}');
    const key = hashContent(text);
    const entry = cache[key];
    if (entry && Date.now() - entry.ts < 3600000) return entry.result; // 1h cache
    return null;
  } catch { return null; }
}

function setCachedModeration(text: string, result: ModerationResult) {
  try {
    const cache = JSON.parse(localStorage.getItem(MODERATION_CACHE_KEY) || '{}');
    const keys = Object.keys(cache);
    // Evict oldest if over 500
    if (keys.length > 500) {
      const sorted = keys.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
      sorted.slice(0, 100).forEach(k => delete cache[k]);
    }
    cache[hashContent(text)] = { result, ts: Date.now() };
    localStorage.setItem(MODERATION_CACHE_KEY, JSON.stringify(cache));
  } catch { }
}

// ── Hook ──
export function useAIEngine() {
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  const setModuleLoading = (module: string, val: boolean) => {
    setLoading(prev => ({ ...prev, [module]: val }));
  };

  const callEngine = useCallback(async <T>(action: string, moduleId: string, body: Record<string, unknown>): Promise<T | null> => {
    setModuleLoading(moduleId, true);
    const start = performance.now();
    try {
      const { data, error } = await supabase.functions.invoke('ai-engine', {
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

  // ── Moderation with cache + self-learning ──
  const moderate = useCallback(async (text: string): Promise<ModerationResult | null> => {
    if (!text || text.trim().length < 3) return { safe: true, score: 0, categories: [], sentiment: 'neutral', emotion: 'trust', confidence: 100, suggestion: '', auto_action: 'allow' };

    // Check cache
    const cached = getCachedModeration(text);
    if (cached) {
      trackAICall('ai-moderator', 1, true);
      return cached;
    }

    const result = await callEngine<ModerationResult>('moderate', 'ai-moderator', { text });
    if (result) setCachedModeration(text, result);
    return result;
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

  // ── Self-learning feedback ──
  const submitFeedback = useCallback(async (entry: Omit<FeedbackEntry, 'timestamp'>) => {
    const feedback: FeedbackEntry = { ...entry, timestamp: new Date().toISOString() };
    const all = loadFeedback();
    all.push(feedback);
    saveFeedback(all);

    // Send to AI for learning
    const result = await callEngine<{ new_rules: string[]; pattern: string }>('learn_feedback', 'self-learning', { feedback });
    if (result?.new_rules) {
      const existing = loadLearnedRules();
      saveLearnedRules([...existing, ...result.new_rules]);
    }

    // Invalidate cache for similar content
    try {
      localStorage.removeItem(MODERATION_CACHE_KEY);
    } catch { }

    toast({ title: '✨ IA améliorée', description: 'Le feedback a été intégré au modèle d\'apprentissage.' });
  }, [callEngine]);

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
    loading,
    feedbackHistory: loadFeedback(),
    learnedRules: loadLearnedRules(),
  };
}
