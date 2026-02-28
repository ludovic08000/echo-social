import { useState, useMemo } from 'react';
import { AppLayout } from '@/components/AppLayout';
import { SEOHead } from '@/components/SEOHead';
import {
  getAIModules, getAIEngineStats, getCategoryLabel, getCategoryColor,
  type AIModule, type AICategory,
} from '@/lib/aiEngine';
import {
  Brain, FileText, Languages, Sparkles, BellRing, ShoppingBag, Crown,
  Circle, Grid3X3, Hash, Heart, Shield, Shuffle, Activity, Zap, Cpu,
  ChevronRight, CheckCircle2, Clock, BarChart3, TrendingUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';

const ICON_MAP: Record<string, React.ElementType> = {
  FileText, Languages, Sparkles, BellRing, ShoppingBag, Crown,
  Circle, Grid3X3, Hash, Heart, Shield, Shuffle,
};

const CATEGORIES: (AICategory | 'all')[] = ['all', 'content', 'social', 'games', 'wellbeing', 'commerce'];

export default function AIEngine() {
  const [selectedCategory, setSelectedCategory] = useState<AICategory | 'all'>('all');
  const [expandedModule, setExpandedModule] = useState<string | null>(null);

  const modules = useMemo(() => getAIModules(), []);
  const stats = useMemo(() => getAIEngineStats(), []);

  const filtered = selectedCategory === 'all'
    ? modules
    : modules.filter(m => m.category === selectedCategory);

  return (
    <AppLayout>
      <SEOHead title="Moteur IA — ForSure" description="Hub centralisé de toutes les intelligences artificielles de ForSure" />

      <div className="max-w-4xl mx-auto px-4 py-6 pb-24 md:pb-8 space-y-8">
        {/* Hero */}
        <header className="relative overflow-hidden rounded-3xl p-8 bg-gradient-to-br from-primary/20 via-accent/10 to-secondary/20 border border-primary/20">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,hsl(var(--primary)/0.15),transparent_60%)]" />
          <div className="absolute top-4 right-4 opacity-10">
            <Brain className="w-32 h-32" />
          </div>
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-12 h-12 rounded-2xl bg-primary/20 border border-primary/30 flex items-center justify-center">
                <Cpu className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground">Moteur IA ForSure</h1>
                <p className="text-sm text-muted-foreground">Intelligence artificielle unifiée</p>
              </div>
            </div>
            <p className="text-muted-foreground text-sm max-w-lg mt-2">
              {stats.totalModules} modules d'intelligence artificielle travaillent ensemble pour personnaliser votre expérience, sécuriser le contenu et rendre chaque interaction plus intelligente.
            </p>
          </div>

          {/* Stats bar */}
          <div className="relative z-10 grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
            <StatCard icon={Cpu} label="Modules" value={stats.totalModules.toString()} />
            <StatCard icon={Zap} label="Actifs" value={stats.activeModules.toString()} accent />
            <StatCard icon={BarChart3} label="Interactions" value={formatNumber(stats.totalInteractions)} />
            <StatCard icon={Activity} label="Santé" value={`${stats.healthScore}%`} />
          </div>
        </header>

        {/* Category filter */}
        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
          {CATEGORIES.map(cat => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={cn(
                'px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all border',
                selectedCategory === cat
                  ? 'bg-primary text-primary-foreground border-primary shadow-lg shadow-primary/20'
                  : 'bg-card/50 text-muted-foreground border-border hover:border-primary/40'
              )}
            >
              {cat === 'all' ? 'Tous' : getCategoryLabel(cat)}
            </button>
          ))}
        </div>

        {/* Modules grid */}
        <div className="grid gap-4">
          {filtered.map(mod => (
            <ModuleCard
              key={mod.id}
              module={mod}
              expanded={expandedModule === mod.id}
              onToggle={() => setExpandedModule(expandedModule === mod.id ? null : mod.id)}
            />
          ))}
        </div>

        {/* Architecture footer */}
        <div className="rounded-2xl border border-border bg-card/50 p-6">
          <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            Architecture du moteur
          </h3>
          <div className="grid sm:grid-cols-3 gap-4 text-xs text-muted-foreground">
            <div className="space-y-1">
              <p className="font-medium text-foreground">Backend IA</p>
              <p>Gemini 3 Flash via Edge Functions pour le résumé et la traduction en temps réel.</p>
            </div>
            <div className="space-y-1">
              <p className="font-medium text-foreground">IA Locale</p>
              <p>Minimax avec élagage α-β pour les jeux. Zero latence réseau, jeu instantané.</p>
            </div>
            <div className="space-y-1">
              <p className="font-medium text-foreground">Algorithmes</p>
              <p>Scoring dynamique, anti-spam multi-critères et rotation équitable marketplace.</p>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
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
      <div className="p-4 flex items-start gap-4">
        <div className={cn(
          "w-11 h-11 rounded-xl flex items-center justify-center shrink-0 border",
          catColor
        )}>
          <Icon className="w-5 h-5" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-foreground text-sm">{module.name}</h3>
            <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 h-4 border", catColor)}>
              {getCategoryLabel(module.category)}
            </Badge>
            <div className="ml-auto flex items-center gap-1">
              <div className={cn(
                "w-2 h-2 rounded-full",
                module.status === 'active' ? "bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400/50" : "bg-muted-foreground"
              )} />
              <span className="text-[10px] text-muted-foreground hidden sm:inline">
                {module.status === 'active' ? 'Actif' : 'Inactif'}
              </span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">{module.description}</p>

          {/* Metrics row */}
          {module.metrics.totalCalls > 0 && (
            <div className="flex items-center gap-4 mt-2 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <BarChart3 className="w-3 h-3" />
                {module.metrics.totalCalls} appels
              </span>
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {module.metrics.avgResponseMs}ms
              </span>
              <span className="flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                {module.metrics.successRate}%
              </span>
            </div>
          )}
        </div>

        <ChevronRight className={cn(
          "w-4 h-4 text-muted-foreground transition-transform shrink-0 mt-1",
          expanded && "rotate-90"
        )} />
      </div>

      {/* Expanded capabilities */}
      {expanded && (
        <div className="px-4 pb-4 pt-0 border-t border-border mt-0">
          <div className="pt-3">
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">Capacités</p>
            <div className="flex flex-wrap gap-1.5">
              {module.capabilities.map(cap => (
                <span
                  key={cap}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] bg-accent/50 text-accent-foreground border border-border"
                >
                  <Zap className="w-2.5 h-2.5 text-primary" />
                  {cap}
                </span>
              ))}
            </div>

            {/* Health bar */}
            <div className="mt-3">
              <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
                <span>Fiabilité</span>
                <span>{module.metrics.successRate}%</span>
              </div>
              <Progress value={module.metrics.successRate} className="h-1.5" />
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
