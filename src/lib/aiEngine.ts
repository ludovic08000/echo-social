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

export type AICategory = 'content' | 'social' | 'games' | 'wellbeing' | 'commerce';

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
    id: 'marketplace-rotation',
    name: 'Rotation Marketplace',
    description: 'Algorithme d\'exposition équitable des vendeurs avec rotation temporelle.',
    category: 'commerce',
    status: 'active',
    icon: 'ShoppingBag',
    capabilities: ['Round-robin vendeurs', 'Rotation horaire', 'Équité d\'exposition'],
  },
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

export function getAIModules(): AIModule[] {
  const metrics = loadMetrics();
  return AI_MODULE_REGISTRY.map(mod => ({
    ...mod,
    metrics: metrics[mod.id] || { totalCalls: 0, avgResponseMs: 0, successRate: 100, lastUsed: null },
  }));
}

export function getAIEngineStats(): AIEngineStats {
  const modules = getAIModules();
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
  };
  return colors[cat];
}
