// ════════════════════════════════════════════════════════════════
// ForSure AI Engine — Unified Intelligence Hub
// Centralizes ALL AI capabilities across the platform
// ════════════════════════════════════════════════════════════════

export interface AIModule {
  id: string;
  name: string;
  description: string;
  category: AICategory;
  status: 'active' | 'idle' | 'disabled';
  icon: string; // lucide icon name
  metrics: AIModuleMetrics;
  capabilities: string[];
}

export type AICategory = 'content' | 'social' | 'games' | 'wellbeing' | 'commerce' | 'moderation' | 'security';

export interface AIModuleMetrics {
  totalCalls: number;
  avgResponseMs: number;
  successRate: number;
  lastUsed: string | null;
}

export interface AIEngineStats {
  totalModules: number;
  activeModules: number;
  totalInteractions: number;
  healthScore: number; // 0-100
}

// ── Registry of all AI modules in the platform ──
const AI_MODULE_REGISTRY: Omit<AIModule, 'metrics'>[] = [
  // ── CONTENT INTELLIGENCE ──
  {
    id: 'content-summarizer',
    name: 'Résumé Intelligent',
    description: 'Résume automatiquement les publications longues en 2-3 phrases clés grâce à Gemini.',
    category: 'content',
    status: 'active',
    icon: 'FileText',
    capabilities: ['Résumé de posts', 'Extraction de points clés', 'Compression sémantique'],
  },
  {
    id: 'auto-translator',
    name: 'Traduction Contextuelle',
    description: 'Traduit le contenu en temps réel tout en préservant le ton et les nuances culturelles.',
    category: 'content',
    status: 'active',
    icon: 'Languages',
    capabilities: ['Multi-langue', 'Préservation du ton', 'Détection automatique'],
  },
  {
    id: 'content-enhancer',
    name: 'Optimiseur de Contenu',
    description: 'Améliore la rédaction, suggère des hashtags et prédit l\'engagement avant publication.',
    category: 'content',
    status: 'active',
    icon: 'Wand2',
    capabilities: ['Réécriture IA', 'Hashtags auto', 'Score lisibilité', 'Prédiction engagement'],
  },

  // ── MODERATION INTELLIGENCE ──
  {
    id: 'ai-moderator',
    name: 'Modération Auto-Apprenante',
    description: 'IA de modération qui apprend des décisions humaines pour s\'améliorer continuellement. Détecte toxicité, spam, harcèlement et désinformation. Intègre un moteur de feedback et de dérivation de règles automatique.',
    category: 'moderation',
    status: 'active',
    icon: 'ShieldCheck',
    capabilities: ['Détection toxicité', 'Anti-harcèlement', 'Anti-désinformation', 'Auto-apprentissage', 'Feedback loop', 'Confiance culturelle', 'Dérivation de règles', 'Reconnaissance de patterns'],
  },
  {
    id: 'sentiment-analyzer',
    name: 'Analyse de Sentiment',
    description: 'Détecte les émotions, le sentiment et prédit la viralité de chaque contenu en temps réel.',
    category: 'moderation',
    status: 'active',
    icon: 'HeartPulse',
    capabilities: ['8 émotions', '5 niveaux sentiment', 'Prédiction viralité', 'Détection thèmes', 'Intensité émotionnelle'],
  },
  {
    id: 'risk-assessor',
    name: 'Évaluation de Risque Profil',
    description: 'Analyse comportementale des profils pour détecter les comptes à risque et les comportements suspects.',
    category: 'moderation',
    status: 'active',
    icon: 'UserSearch',
    capabilities: ['Score de confiance', 'Détection bots', 'Patterns comportementaux', 'Actions automatiques'],
  },

  // ── SOCIAL INTELLIGENCE ──
  {
    id: 'feed-algorithm',
    name: 'Algorithme de Feed',
    description: 'Moteur de scoring dynamique avec anti-spam, anti-biais et diversité de contenu.',
    category: 'social',
    status: 'active',
    icon: 'Sparkles',
    capabilities: ['Scoring dynamique', 'Anti-spam', 'Anti-biais', 'Diversité', 'Pondération configurable'],
  },
  {
    id: 'notification-grouping',
    name: 'Notifications Intelligentes',
    description: 'Regroupe intelligemment les notifications similaires pour réduire le bruit.',
    category: 'social',
    status: 'active',
    icon: 'BellRing',
    capabilities: ['Groupement par type', 'Déduplication', 'Prioritisation'],
  },
  {
    id: 'smart-reply',
    name: 'Réponses Intelligentes',
    description: 'Génère 3 suggestions de réponses contextuelles adaptées au ton de la conversation.',
    category: 'social',
    status: 'active',
    icon: 'MessageSquareText',
    capabilities: ['3 suggestions', 'Détection du ton', 'Multi-langue', 'Contextuel'],
  },
  {
    id: 'recommendation-engine',
    name: 'Moteur de Recommandations',
    description: 'Recommande du contenu adapté aux centres d\'intérêt avec diversité intégrée et détection de fatigue.',
    category: 'social',
    status: 'active',
    icon: 'Compass',
    capabilities: ['Profil personnalité', 'Anti-fatigue', 'Diversité forcée', 'Créneaux optimaux'],
  },

  // ── COMMERCE INTELLIGENCE ──
  {
    id: 'marketplace-rotation',
    name: 'Rotation Marketplace',
    description: 'Algorithme d\'exposition équitable des vendeurs avec rotation temporelle.',
    category: 'commerce',
    status: 'active',
    icon: 'ShoppingBag',
    capabilities: ['Round-robin vendeurs', 'Rotation horaire', 'Équité d\'exposition'],
  },

  // ── GAME INTELLIGENCE ──
  {
    id: 'chess-ai',
    name: 'IA Échecs',
    description: 'Moteur minimax avec élagage alpha-bêta, évaluation positionnelle et comportement humain.',
    category: 'games',
    status: 'active',
    icon: 'Crown',
    capabilities: ['3 niveaux', 'Élagage α-β', 'Contrôle du centre', 'Blunders réalistes'],
  },
  {
    id: 'checkers-ai',
    name: 'IA Dames',
    description: 'Moteur de recherche avec évaluation des pions, promotion et captures forcées.',
    category: 'games',
    status: 'active',
    icon: 'Circle',
    capabilities: ['3 niveaux', 'Captures obligatoires', 'Promotion Roi', 'Positionnement'],
  },
  {
    id: 'connect4-ai',
    name: 'IA Puissance 4',
    description: 'Analyse de fenêtres de 4, contrôle du centre et recherche en profondeur variable.',
    category: 'games',
    status: 'active',
    icon: 'Grid3X3',
    capabilities: ['3 niveaux', 'Évaluation fenêtres', 'Centre prioritaire', 'Profondeur 5'],
  },
  {
    id: 'tictactoe-ai',
    name: 'IA Morpion',
    description: 'Minimax parfait pour une stratégie optimale avec comportement humain aux niveaux faciles.',
    category: 'games',
    status: 'active',
    icon: 'Hash',
    capabilities: ['3 niveaux', 'Minimax pur', 'Jeu parfait (difficile)', 'Aléatoire (facile)'],
  },

  // ── WELLBEING INTELLIGENCE ──
  {
    id: 'wellbeing-tracker',
    name: 'Bien-être Digital',
    description: 'Suivi du temps d\'écran, rappels de pause et mode niveaux de gris automatique.',
    category: 'wellbeing',
    status: 'active',
    icon: 'Heart',
    capabilities: ['Suivi temps', 'Rappels pause', 'Limite quotidienne', 'Mode grayscale'],
  },
  {
    id: 'spam-detector',
    name: 'Détecteur Anti-Spam',
    description: 'Analyse multi-critères : répétitions, liens, majuscules, mots-clés et emojis excessifs.',
    category: 'content',
    status: 'active',
    icon: 'Shield',
    capabilities: ['Répétitions', 'Densité liens', 'Ratio majuscules', 'Mots spam', 'Score 0-100'],
  },
  {
    id: 'diversity-engine',
    name: 'Moteur Anti-Biais',
    description: 'Pénalise les contenus répétitifs d\'un même auteur pour diversifier le flux.',
    category: 'social',
    status: 'active',
    icon: 'Shuffle',
    capabilities: ['Pénalité auteur', 'Rotation contenu', 'Bulle de filtre brisée'],
  },

  // ── SECURITY INTELLIGENCE ──
  {
    id: 'intrusion-detector',
    name: 'Détection d\'Intrusion',
    description: 'Analyse en temps réel des tentatives d\'intrusion : brute-force, injection SQL, XSS, CSRF et escalade de privilèges.',
    category: 'security',
    status: 'active',
    icon: 'ShieldAlert',
    capabilities: ['Anti brute-force', 'Détection SQL injection', 'Anti XSS', 'Anti CSRF', 'Alertes temps réel'],
  },
  {
    id: 'ip-analyzer',
    name: 'Analyse IP & Géolocalisation',
    description: 'Surveillance des adresses IP, détection VPN/Tor/proxy, géolocalisation et blocage automatique des IP malveillantes.',
    category: 'security',
    status: 'active',
    icon: 'Globe',
    capabilities: ['Log IP', 'Détection VPN/Tor', 'Géolocalisation', 'Blacklist auto', 'Corrélation multi-comptes'],
  },
  {
    id: 'packet-inspector',
    name: 'Inspecteur de Paquets',
    description: 'Analyse deep packet inspection (DPI) des requêtes HTTP pour détecter payloads malveillants et traffic anormal.',
    category: 'security',
    status: 'active',
    icon: 'Network',
    capabilities: ['DPI HTTP', 'Détection payloads', 'Analyse headers', 'Rate limiting adaptatif', 'Signature matching'],
  },
  {
    id: 'vuln-scanner',
    name: 'Scanner de Vulnérabilités',
    description: 'Scan automatisé des endpoints, dépendances et configurations pour identifier et corriger les failles de sécurité.',
    category: 'security',
    status: 'active',
    icon: 'ScanSearch',
    capabilities: ['Scan endpoints', 'Audit dépendances', 'OWASP Top 10', 'Auto-correction', 'Rapport détaillé'],
  },
  {
    id: 'ddos-shield',
    name: 'Bouclier Anti-DDoS',
    description: 'Protection contre les attaques par déni de service avec rate limiting intelligent et absorption de trafic.',
    category: 'security',
    status: 'active',
    icon: 'ShieldOff',
    capabilities: ['Rate limiting IA', 'Absorption trafic', 'Challenge CAPTCHA', 'Blackhole routing', 'Alertes seuil'],
  },
  {
    id: 'session-guardian',
    name: 'Gardien de Sessions',
    description: 'Détection de vol de session, hijacking JWT, et anomalies comportementales dans les sessions utilisateur.',
    category: 'security',
    status: 'active',
    icon: 'KeyRound',
    capabilities: ['Anti session hijack', 'Anomalie JWT', 'Fingerprint session', 'Révocation auto', 'Logs audit'],
  },
];

// ── Metrics tracking ──
const METRICS_KEY = 'forsure-ai-metrics';

function loadMetrics(): Record<string, AIModuleMetrics> {
  try {
    return JSON.parse(localStorage.getItem(METRICS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveMetrics(metrics: Record<string, AIModuleMetrics>) {
  localStorage.setItem(METRICS_KEY, JSON.stringify(metrics));
}

export function trackAICall(moduleId: string, responseMs: number, success: boolean) {
  const all = loadMetrics();
  const existing = all[moduleId] || { totalCalls: 0, avgResponseMs: 0, successRate: 100, lastUsed: null };
  const newTotal = existing.totalCalls + 1;
  const newAvg = (existing.avgResponseMs * existing.totalCalls + responseMs) / newTotal;
  const successCount = Math.round(existing.successRate / 100 * existing.totalCalls) + (success ? 1 : 0);
  all[moduleId] = {
    totalCalls: newTotal,
    avgResponseMs: Math.round(newAvg),
    successRate: Math.round((successCount / newTotal) * 100),
    lastUsed: new Date().toISOString(),
  };
  saveMetrics(all);
}

// ── Server-side realtime stats (admin) ──
import { supabase } from '@/integrations/supabase/client';

export async function fetchServerMetrics(windowMinutes = 1440): Promise<Record<string, AIModuleMetrics>> {
  try {
    const { data, error } = await supabase.rpc('ai_engine_module_stats' as any, { p_window_minutes: windowMinutes });
    if (error || !Array.isArray(data)) return {};
    const out: Record<string, AIModuleMetrics> = {};
    for (const row of data as Array<{ module_id: string; total_calls: number; avg_latency_ms: number; success_rate: number; last_used: string }>) {
      out[row.module_id] = {
        totalCalls: Number(row.total_calls) || 0,
        avgResponseMs: Number(row.avg_latency_ms) || 0,
        successRate: Number(row.success_rate) ?? 100,
        lastUsed: row.last_used,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function subscribeAIEvents(onEvent: () => void) {
  const channel = supabase
    .channel('ai-engine-events')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ai_engine_events' }, () => onEvent())
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}

export function getAIModules(serverMetrics?: Record<string, AIModuleMetrics>): AIModule[] {
  const localMetrics = loadMetrics();
  return AI_MODULE_REGISTRY.map(mod => {
    const server = serverMetrics?.[mod.id];
    const local = localMetrics[mod.id];
    const merged: AIModuleMetrics = server
      ? {
          totalCalls: (server.totalCalls || 0) + (local?.totalCalls || 0),
          avgResponseMs: server.avgResponseMs || local?.avgResponseMs || 0,
          successRate: server.successRate ?? local?.successRate ?? 100,
          lastUsed: server.lastUsed || local?.lastUsed || null,
        }
      : (local || { totalCalls: 0, avgResponseMs: 0, successRate: 100, lastUsed: null });
    return { ...mod, metrics: merged };
  });
}

export function getAIEngineStats(serverMetrics?: Record<string, AIModuleMetrics>): AIEngineStats {
  const modules = getAIModules(serverMetrics);
  const active = modules.filter(m => m.status === 'active');
  const totalInteractions = modules.reduce((sum, m) => sum + m.metrics.totalCalls, 0);
  const avgSuccess = active.length > 0
    ? Math.round(active.reduce((sum, m) => sum + m.metrics.successRate, 0) / active.length)
    : 100;
  return {
    totalModules: modules.length,
    activeModules: active.length,
    totalInteractions,
    healthScore: avgSuccess,
  };
}

export function getCategoryLabel(cat: AICategory): string {
  const labels: Record<AICategory, string> = {
    content: 'Contenu',
    social: 'Social',
    games: 'Jeux',
    wellbeing: 'Bien-être',
    commerce: 'Commerce',
    moderation: 'Modération',
    security: 'Sécurité',
  };
  return labels[cat];
}

export function getCategoryColor(cat: AICategory): string {
  const colors: Record<AICategory, string> = {
    content: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    social: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    games: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    wellbeing: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    commerce: 'bg-rose-500/20 text-rose-400 border-rose-500/30',
    moderation: 'bg-red-500/20 text-red-400 border-red-500/30',
    security: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  };
  return colors[cat];
}
