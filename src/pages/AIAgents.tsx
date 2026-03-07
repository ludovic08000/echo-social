import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bot, Crown, ArrowLeft, Sparkles, MessageCircle, Zap } from 'lucide-react';
import { AppLayout } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAIAgentsList, type AIAgent } from '@/hooks/useAIAgents';
import { AIAgentChat } from '@/components/agents/AIAgentChat';
import { cn } from '@/lib/utils';

const CATEGORY_LABELS: Record<string, string> = {
  marketing: '📈 Marketing',
  community: '💬 Community',
  content: '✍️ Contenu',
  assistant: '🧠 Assistant',
  general: '🤖 Général',
};

export default function AIAgents() {
  const { data: agents, isLoading } = useAIAgentsList();
  const [selectedAgent, setSelectedAgent] = useState<AIAgent | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const categories = [...new Set(agents?.map(a => a.category) || [])];
  const filtered = activeCategory
    ? agents?.filter(a => a.category === activeCategory)
    : agents;

  if (selectedAgent) {
    return (
      <AppLayout>
        <AIAgentChat agent={selectedAgent} onBack={() => setSelectedAgent(null)} />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="text-center space-y-2">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-2xl bg-primary/10 border border-primary/20 mb-2">
            <Bot className="w-5 h-5 text-primary" />
            <span className="text-sm font-semibold text-primary">Agents IA ForSure</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground">Vos assistants intelligents</h1>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Des agents IA spécialisés pour vous aider en marketing, création de contenu, gestion de communauté et plus encore.
          </p>
        </motion.div>

        {/* Freemium info */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}
          className="flex items-center gap-3 p-3 rounded-xl bg-secondary/40 border border-border/30">
          <Zap className="w-5 h-5 text-amber-500 shrink-0" />
          <div className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Freemium</span> · 5 messages gratuits/jour par agent. 
            Les agents <Crown className="w-3 h-3 inline text-amber-500" /> Premium offrent 3 msg/jour.
          </div>
        </motion.div>

        {/* Category filters */}
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setActiveCategory(null)}
            className={cn(
              'px-3 py-1.5 rounded-xl text-xs font-medium transition-all border',
              !activeCategory ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary/40 text-muted-foreground border-border/30 hover:border-primary/30'
            )}
          >
            Tous
          </button>
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat === activeCategory ? null : cat)}
              className={cn(
                'px-3 py-1.5 rounded-xl text-xs font-medium transition-all border',
                activeCategory === cat ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary/40 text-muted-foreground border-border/30 hover:border-primary/30'
              )}
            >
              {CATEGORY_LABELS[cat] || cat}
            </button>
          ))}
        </div>

        {/* Agent cards */}
        {isLoading ? (
          <div className="grid gap-3">
            {[1,2,3].map(i => (
              <div key={i} className="h-28 rounded-2xl bg-secondary/30 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid gap-3">
            <AnimatePresence>
              {filtered?.map((agent, i) => (
                <motion.button
                  key={agent.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ delay: i * 0.05 }}
                  onClick={() => setSelectedAgent(agent)}
                  className="w-full text-left p-4 rounded-2xl border border-border/30 bg-card hover:border-primary/20 hover:shadow-[0_4px_20px_hsl(220_70%_50%/0.08)] transition-all group"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-2xl shrink-0 group-hover:scale-105 transition-transform">
                      {agent.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold text-sm text-foreground">{agent.name}</h3>
                        {agent.is_premium && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 gap-0.5 bg-amber-500/15 text-amber-600 border-amber-500/20">
                            <Crown className="w-2.5 h-2.5" /> Premium
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-2">{agent.description}</p>
                      <div className="flex items-center gap-3 mt-2">
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <MessageCircle className="w-3 h-3" /> {agent.free_messages_per_day} msg/jour
                        </span>
                        <span className="text-[10px] px-2 py-0.5 rounded-md bg-secondary/60 text-muted-foreground">
                          {CATEGORY_LABELS[agent.category] || agent.category}
                        </span>
                      </div>
                    </div>
                    <Sparkles className="w-4 h-4 text-primary opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-1" />
                  </div>
                </motion.button>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
