import { useState, useMemo, useCallback, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { AppLayout } from '@/components/AppLayout';
import { SEOHead } from '@/components/SEOHead';
import {
  getAIModules, getAIEngineStats, getCategoryLabel, getCategoryColor,
  type AIModule, type AICategory,
} from '@/lib/aiEngine';
import { useAIEngine, type ModerationResult, type SentimentResult } from '@/hooks/useAIEngine';
import {
  Brain, FileText, Languages, Sparkles, BellRing, ShoppingBag, Crown,
  Circle, Grid3X3, Hash, Heart, Shield, Shuffle, Activity, Zap, Cpu,
  ChevronRight, CheckCircle2, Clock, BarChart3, TrendingUp, ShieldCheck,
  HeartPulse, GraduationCap, UserSearch, Wand2, MessageSquareText, Compass,
  Send, AlertTriangle, ThumbsUp, ThumbsDown, Loader2, Eye, BookOpen,
  Globe, Network, ScanSearch, ShieldOff, KeyRound, ShieldAlert,
  Bug, Radio, Wifi, Lock, ServerCrash, AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const ICON_MAP: Record<string, React.ElementType> = {
  FileText, Languages, Sparkles, BellRing, ShoppingBag, Crown,
  Circle, Grid3X3, Hash, Heart, Shield, Shuffle, ShieldCheck,
  HeartPulse, GraduationCap, UserSearch, Wand2, MessageSquareText, Compass,
};

const CATEGORIES: (AICategory | 'all')[] = ['all', 'moderation', 'content', 'social', 'games', 'wellbeing', 'commerce'];

export default function AIEngine() {
  const [selectedCategory, setSelectedCategory] = useState<AICategory | 'all'>('all');
  const [expandedModule, setExpandedModule] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('modules');

  const modules = useMemo(() => getAIModules(), []);
  const stats = useMemo(() => getAIEngineStats(), []);

  const filtered = selectedCategory === 'all'
    ? modules
    : modules.filter(m => m.category === selectedCategory);

  return (
    <AppLayout>
      <SEOHead title="Moteur IA — ForSure" description="Intelligence artificielle auto-apprenante et modération révolutionnaire" />

      <div className="max-w-4xl mx-auto px-4 py-6 pb-24 md:pb-8 space-y-6">
        {/* Hero */}
        <header className="relative overflow-hidden rounded-3xl p-6 sm:p-8 bg-gradient-to-br from-primary/20 via-accent/10 to-secondary/20 border border-primary/20">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,hsl(var(--primary)/0.15),transparent_60%)]" />
          <div className="absolute top-4 right-4 opacity-[0.07]">
            <Brain className="w-40 h-40" />
          </div>
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-12 h-12 rounded-2xl bg-primary/20 border border-primary/30 flex items-center justify-center animate-pulse">
                <Cpu className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground">ForSure Neural Engine</h1>
                <p className="text-xs text-muted-foreground">IA auto-apprenante • Modération adaptative • {stats.totalModules} modules</p>
              </div>
            </div>
          </div>

          <div className="relative z-10 grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5">
            <StatCard icon={Cpu} label="Modules IA" value={stats.totalModules.toString()} />
            <StatCard icon={Zap} label="Actifs" value={stats.activeModules.toString()} accent />
            <StatCard icon={BarChart3} label="Interactions" value={formatNumber(stats.totalInteractions)} />
            <StatCard icon={Activity} label="Santé" value={`${stats.healthScore}%`} />
          </div>
        </header>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="w-full grid grid-cols-3 h-11">
            <TabsTrigger value="modules" className="text-xs sm:text-sm">
              <Cpu className="w-3.5 h-3.5 mr-1.5" />Modules
            </TabsTrigger>
            <TabsTrigger value="playground" className="text-xs sm:text-sm">
              <Wand2 className="w-3.5 h-3.5 mr-1.5" />Playground
            </TabsTrigger>
            <TabsTrigger value="learning" className="text-xs sm:text-sm">
              <GraduationCap className="w-3.5 h-3.5 mr-1.5" />Apprentissage
            </TabsTrigger>
          </TabsList>

          <TabsContent value="modules" className="space-y-4 mt-4">
            {/* Category filter */}
            <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
              {CATEGORIES.map(cat => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={cn(
                    'px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all border',
                    selectedCategory === cat
                      ? 'bg-primary text-primary-foreground border-primary shadow-lg shadow-primary/20'
                      : 'bg-card/50 text-muted-foreground border-border hover:border-primary/40'
                  )}
                >
                  {cat === 'all' ? `Tous (${modules.length})` : `${getCategoryLabel(cat)} (${modules.filter(m => m.category === cat).length})`}
                </button>
              ))}
            </div>

            <div className="grid gap-3">
              {filtered.map(mod => (
                <ModuleCard
                  key={mod.id}
                  module={mod}
                  expanded={expandedModule === mod.id}
                  onToggle={() => setExpandedModule(expandedModule === mod.id ? null : mod.id)}
                />
              ))}
            </div>
          </TabsContent>

          <TabsContent value="playground" className="mt-4">
            <AIPlayground />
          </TabsContent>

          <TabsContent value="learning" className="mt-4">
            <LearningDashboard />
          </TabsContent>
        </Tabs>

        {/* Architecture */}
        <div className="rounded-2xl border border-border bg-card/50 p-5">
          <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            Architecture neurale
          </h3>
          <div className="grid sm:grid-cols-4 gap-4 text-xs text-muted-foreground">
            <div className="space-y-1">
              <p className="font-medium text-foreground">🧠 Gemini 3 Flash</p>
              <p>Modération, sentiment, recommandations et génération via edge functions.</p>
            </div>
            <div className="space-y-1">
              <p className="font-medium text-foreground">🎮 Minimax Local</p>
              <p>4 IA de jeux avec élagage α-β. Zero latence réseau.</p>
            </div>
            <div className="space-y-1">
              <p className="font-medium text-foreground">📊 Scoring Feed</p>
              <p>Anti-spam, anti-biais, pondération et rotation marketplace.</p>
            </div>
            <div className="space-y-1">
              <p className="font-medium text-foreground">🔄 Auto-Learning</p>
              <p>Feedback loop continu. Chaque correction améliore le modèle.</p>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

// ── AI Playground ──
function AIPlayground() {
  const [text, setText] = useState('');
  const [modResult, setModResult] = useState<ModerationResult | null>(null);
  const [sentimentResult, setSentimentResult] = useState<SentimentResult | null>(null);
  const [enhanceResult, setEnhanceResult] = useState<{ enhanced: string; hashtags: string[]; improvements: string[]; engagement_boost_estimate: number } | null>(null);
  const [smartReplies, setSmartReplies] = useState<string[] | null>(null);
  const { moderate, analyzeSentiment, enhanceContent, getSmartReplies, loading } = useAIEngine();

  const runAll = useCallback(async () => {
    if (!text.trim()) return;
    setModResult(null);
    setSentimentResult(null);
    setEnhanceResult(null);
    setSmartReplies(null);

    const [mod, sent, enh, replies] = await Promise.all([
      moderate(text),
      analyzeSentiment(text),
      enhanceContent(text),
      getSmartReplies(text),
    ]);
    setModResult(mod);
    setSentimentResult(sent);
    setEnhanceResult(enh);
    if (replies) setSmartReplies(replies.replies);
  }, [text, moderate, analyzeSentiment, enhanceContent, getSmartReplies]);

  const isLoading = Object.values(loading).some(Boolean);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-card p-4">
        <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
          <Wand2 className="w-3.5 h-3.5 text-primary" />
          Testez le moteur IA en temps réel
        </p>
        <Textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Écrivez ou collez du contenu pour tester la modération, le sentiment, l'amélioration..."
          className="min-h-[80px] resize-none"
        />
        <button
          onClick={runAll}
          disabled={!text.trim() || isLoading}
          className={cn(
            "mt-3 w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-all",
            "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          )}
        >
          {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          {isLoading ? 'Analyse en cours...' : 'Analyser avec tous les modules'}
        </button>
      </div>

      {/* Results */}
      {(modResult || sentimentResult || enhanceResult || smartReplies) && (
        <div className="grid sm:grid-cols-2 gap-3">
          {/* Moderation */}
          {modResult && (
            <ResultCard
              title="Modération"
              icon={<ShieldCheck className="w-4 h-4" />}
              color={modResult.safe ? 'text-emerald-400' : 'text-red-400'}
            >
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={cn("text-[10px]", modResult.safe ? "border-emerald-500/30 text-emerald-400" : "border-red-500/30 text-red-400")}>
                    {modResult.safe ? '✅ Sûr' : '⚠️ Risqué'}
                  </Badge>
                  <span className="text-xs text-muted-foreground">Toxicité: {modResult.score}/100</span>
                  <span className="text-xs text-muted-foreground">Confiance: {modResult.confidence}%</span>
                </div>
                <Progress value={modResult.score} className="h-1.5" />
                <div className="flex items-center gap-2 text-[10px]">
                  <span className="text-muted-foreground">Action:</span>
                  <Badge variant="outline" className="text-[10px]">{modResult.auto_action}</Badge>
                </div>
                {modResult.categories.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {modResult.categories.map(c => (
                      <Badge key={c} variant="destructive" className="text-[10px] px-1.5">{c}</Badge>
                    ))}
                  </div>
                )}
                {modResult.suggestion && <p className="text-[11px] text-muted-foreground italic">{modResult.suggestion}</p>}
              </div>
            </ResultCard>
          )}

          {/* Sentiment */}
          {sentimentResult && (
            <ResultCard title="Sentiment & Émotions" icon={<HeartPulse className="w-4 h-4" />} color="text-purple-400">
              <div className="space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-[10px] border-purple-500/30 text-purple-400">{sentimentResult.sentiment}</Badge>
                  <Badge variant="outline" className="text-[10px]">{sentimentResult.emotion}</Badge>
                  {sentimentResult.secondary_emotions?.map(e => (
                    <Badge key={e} variant="outline" className="text-[10px] opacity-60">{e}</Badge>
                  ))}
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>Intensité: {sentimentResult.intensity}%</span>
                  <span>Viralité: {sentimentResult.virality_score}/100</span>
                </div>
                <Progress value={sentimentResult.intensity} className="h-1.5" />
                <div className="flex items-center gap-1 text-[10px]">
                  <span className="text-muted-foreground">Engagement prédit:</span>
                  <Badge variant="outline" className="text-[10px]">{sentimentResult.engagement_prediction}</Badge>
                </div>
                {sentimentResult.topics?.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {sentimentResult.topics.map(t => (
                      <span key={t} className="text-[10px] px-2 py-0.5 rounded-md bg-accent/50 text-accent-foreground">#{t}</span>
                    ))}
                  </div>
                )}
              </div>
            </ResultCard>
          )}

          {/* Enhancement */}
          {enhanceResult && (
            <ResultCard title="Contenu Amélioré" icon={<Wand2 className="w-4 h-4" />} color="text-blue-400">
              <div className="space-y-2">
                <p className="text-xs text-foreground bg-accent/30 rounded-lg p-2">{enhanceResult.enhanced}</p>
                <div className="flex flex-wrap gap-1">
                  {enhanceResult.hashtags?.map(h => (
                    <span key={h} className="text-[10px] px-2 py-0.5 rounded-md bg-primary/10 text-primary">#{h}</span>
                  ))}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>+{enhanceResult.engagement_boost_estimate}% engagement</span>
                </div>
                {enhanceResult.improvements?.length > 0 && (
                  <ul className="space-y-0.5">
                    {enhanceResult.improvements.map((imp, i) => (
                      <li key={i} className="text-[10px] text-muted-foreground flex items-start gap-1">
                        <CheckCircle2 className="w-3 h-3 text-primary shrink-0 mt-0.5" />{imp}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </ResultCard>
          )}

          {/* Smart Replies */}
          {smartReplies && (
            <ResultCard title="Réponses Suggérées" icon={<MessageSquareText className="w-4 h-4" />} color="text-amber-400">
              <div className="space-y-1.5">
                {smartReplies.map((r, i) => (
                  <div key={i} className="text-xs p-2 rounded-lg bg-accent/30 text-foreground border border-border hover:border-primary/30 transition-colors cursor-pointer">
                    {r}
                  </div>
                ))}
              </div>
            </ResultCard>
          )}
        </div>
      )}
    </div>
  );
}

// ── Learning Dashboard ──
function LearningDashboard() {
  const { feedbackHistory, learnedRules, loadFeedbackHistory } = useAIEngine();
  const [newRule, setNewRule] = useState('');
  const [newPattern, setNewPattern] = useState('');
  const [addingRule, setAddingRule] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  useEffect(() => {
    loadFeedbackHistory();
  }, [loadFeedbackHistory]);

  const handleAddRule = useCallback(async () => {
    if (!newRule.trim()) return;
    setAddingRule(true);
    try {
      const { error } = await supabase.from('ai_learned_rules').insert({
        rule: newRule.trim(),
        pattern: newPattern.trim() || null,
      });
      if (error) throw error;
      setNewRule('');
      setNewPattern('');
      setShowAddForm(false);
      loadFeedbackHistory();
    } catch (e) {
      console.error('Error adding rule:', e);
    } finally {
      setAddingRule(false);
    }
  }, [newRule, newPattern, loadFeedbackHistory]);

  const handleDeleteRule = useCallback(async (id: string) => {
    try {
      await supabase.from('ai_learned_rules').delete().eq('id', id);
      loadFeedbackHistory();
    } catch (e) {
      console.error('Error deleting rule:', e);
    }
  }, [loadFeedbackHistory]);

  return (
    <div className="space-y-4">
      {/* Learned rules */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <GraduationCap className="w-4 h-4 text-primary" />
            Règles de modération
            <Badge variant="outline" className="text-[10px]">{learnedRules.length}</Badge>
          </h3>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {showAddForm ? <AlertTriangle className="w-3 h-3" /> : <Zap className="w-3 h-3" />}
            {showAddForm ? 'Annuler' : 'Ajouter une règle'}
          </button>
        </div>

        {/* Add rule form */}
        {showAddForm && (
          <div className="mb-4 p-3 rounded-xl border border-primary/20 bg-primary/5 space-y-3">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Règle de modération *</label>
              <Textarea
                value={newRule}
                onChange={e => setNewRule(e.target.value)}
                placeholder="Ex: Bloquer les messages contenant des liens de phishing connus"
                className="min-h-[60px] resize-none text-xs"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Pattern / Regex (optionnel)</label>
              <input
                type="text"
                value={newPattern}
                onChange={e => setNewPattern(e.target.value)}
                placeholder="Ex: (bit\.ly|tinyurl\.com)/[a-z0-9]+"
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <button
              onClick={handleAddRule}
              disabled={!newRule.trim() || addingRule}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {addingRule ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              {addingRule ? 'Ajout...' : 'Enregistrer la règle'}
            </button>
          </div>
        )}

        {learnedRules.length === 0 ? (
          <div className="text-center py-6">
            <Brain className="w-10 h-10 mx-auto text-muted-foreground/30 mb-2" />
            <p className="text-xs text-muted-foreground">Aucune règle définie pour le moment.</p>
            <p className="text-[10px] text-muted-foreground mt-1">Ajoutez des règles ou utilisez le Playground pour entraîner l'IA.</p>
          </div>
        ) : (
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {learnedRules.map((rule) => (
              <div key={rule.id} className="flex items-start gap-2 text-xs p-2.5 rounded-lg bg-accent/30 border border-border group">
                <BookOpen className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <span className="text-foreground">{rule.rule}</span>
                  {rule.pattern && (
                    <p className="text-[10px] text-muted-foreground mt-0.5 font-mono truncate">Pattern: {rule.pattern}</p>
                  )}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteRule(rule.id); }}
                  className="opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive/80 transition-opacity shrink-0"
                  title="Supprimer"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Feedback history */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <Activity className="w-4 h-4 text-primary" />
          Historique des corrections
          <Badge variant="outline" className="text-[10px] ml-auto">{feedbackHistory.length} feedbacks</Badge>
        </h3>
        {feedbackHistory.length === 0 ? (
          <div className="text-center py-6">
            <ThumbsUp className="w-10 h-10 mx-auto text-muted-foreground/30 mb-2" />
            <p className="text-xs text-muted-foreground">Aucun feedback enregistré.</p>
            <p className="text-[10px] text-muted-foreground mt-1">Chaque correction humaine améliore la précision de l'IA.</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {feedbackHistory.slice(-20).reverse().map((fb, i) => (
              <div key={i} className="text-xs p-2 rounded-lg bg-accent/20 border border-border">
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="outline" className="text-[10px]">{fb.aiDecision}</Badge>
                  <span className="text-muted-foreground">→</span>
                  <Badge variant="outline" className="text-[10px] border-primary/30 text-primary">{fb.humanDecision}</Badge>
                  <span className="text-[10px] text-muted-foreground ml-auto">{fb.created_at ? new Date(fb.created_at).toLocaleDateString('fr') : ''}</span>
                </div>
                <p className="text-muted-foreground line-clamp-1">{fb.originalText}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Self-learning status */}
      <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/20 border border-primary/30 flex items-center justify-center">
            <Brain className="w-5 h-5 text-primary animate-pulse" />
          </div>
          <div className="flex-1">
            <h4 className="text-sm font-semibold text-foreground">Boucle d'apprentissage active</h4>
            <p className="text-[11px] text-muted-foreground">
              Chaque feedback est analysé par Gemini pour dériver de nouvelles règles de modération. Le modèle s'améliore à chaque correction.
            </p>
          </div>
          <div className="w-3 h-3 rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/50 animate-pulse" />
        </div>
      </div>
    </div>
  );
}

// ── Shared Components ──
function ResultCard({ title, icon, color, children }: { title: string; icon: React.ReactNode; color: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <h4 className={cn("text-xs font-semibold mb-2 flex items-center gap-1.5", color)}>
        {icon} {title}
      </h4>
      {children}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, accent }: { icon: React.ElementType; label: string; value: string; accent?: boolean }) {
  return (
    <div className={cn(
      "rounded-xl p-3 border",
      accent ? "bg-primary/10 border-primary/30" : "bg-card/60 border-border"
    )}>
      <div className="flex items-center gap-2 mb-1">
        <Icon className={cn("w-3.5 h-3.5", accent ? "text-primary" : "text-muted-foreground")} />
        <span className="text-[11px] text-muted-foreground">{label}</span>
      </div>
      <p className={cn("text-lg font-bold", accent ? "text-primary" : "text-foreground")}>{value}</p>
    </div>
  );
}

function ModuleCard({ module, expanded, onToggle }: { module: AIModule; expanded: boolean; onToggle: () => void }) {
  const Icon = ICON_MAP[module.icon] || Brain;
  const catColor = getCategoryColor(module.category);

  return (
    <button
      onClick={onToggle}
      className={cn(
        "w-full text-left rounded-2xl border transition-all duration-300",
        expanded
          ? "bg-card border-primary/30 shadow-lg shadow-primary/5"
          : "bg-card/50 border-border hover:border-primary/20 hover:bg-card/80"
      )}
    >
      <div className="p-3 sm:p-4 flex items-start gap-3">
        <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border", catColor)}>
          <Icon className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <h3 className="font-semibold text-foreground text-sm">{module.name}</h3>
            <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 h-4 border", catColor)}>
              {getCategoryLabel(module.category)}
            </Badge>
            <div className="ml-auto flex items-center gap-1">
              <div className={cn(
                "w-2 h-2 rounded-full",
                module.status === 'active' ? "bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400/50" : "bg-muted-foreground"
              )} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">{module.description}</p>
          {module.metrics.totalCalls > 0 && (
            <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1"><BarChart3 className="w-3 h-3" />{module.metrics.totalCalls}</span>
              <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{module.metrics.avgResponseMs}ms</span>
              <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />{module.metrics.successRate}%</span>
            </div>
          )}
        </div>
        <ChevronRight className={cn("w-4 h-4 text-muted-foreground transition-transform shrink-0 mt-1", expanded && "rotate-90")} />
      </div>

      {expanded && (
        <div className="px-3 sm:px-4 pb-3 pt-0 border-t border-border">
          <div className="pt-2.5">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Capacités</p>
            <div className="flex flex-wrap gap-1">
              {module.capabilities.map(cap => (
                <span key={cap} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] bg-accent/50 text-accent-foreground border border-border">
                  <Zap className="w-2.5 h-2.5 text-primary" />{cap}
                </span>
              ))}
            </div>
            <div className="mt-2">
              <div className="flex justify-between text-[10px] text-muted-foreground mb-0.5">
                <span>Fiabilité</span><span>{module.metrics.successRate}%</span>
              </div>
              <Progress value={module.metrics.successRate} className="h-1" />
            </div>
          </div>
        </div>
      )}
    </button>
  );
}

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}
