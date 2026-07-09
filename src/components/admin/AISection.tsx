import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Cpu, MessageSquare, Zap, Brain, Bot } from 'lucide-react';
import { getAIModules, getAIEngineStats, getCategoryLabel, getCategoryColor } from '@/lib/ml/aiEngine';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

export function AISection() {
  const modules = getAIModules();
  const stats = getAIEngineStats();

  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: ['admin-ai-agents'],
    queryFn: async () => {
      const { data, error } = await supabase.from('ai_agents').select('*').order('sort_order');
      if (error) throw error;
      return data;
    },
  });

  const { data: usageStats } = useQuery({
    queryKey: ['admin-ai-usage'],
    queryFn: async () => {
      const { data } = await supabase.from('ai_agent_usage').select('agent_id, message_count, usage_date').gte('usage_date', new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]);
      const totalMessages = (data || []).reduce((s, u) => s + (u.message_count || 0), 0);
      const uniqueAgents = new Set((data || []).map(u => u.agent_id)).size;
      return { totalMessages, uniqueAgents, entries: data?.length || 0 };
    },
  });

  const { data: feedbackStats } = useQuery({
    queryKey: ['admin-ai-feedback'],
    queryFn: async () => {
      const { count: totalFeedback } = await supabase.from('ai_feedback').select('id', { count: 'exact', head: true });
      const { count: learnedRules } = await supabase.from('ai_learned_rules').select('id', { count: 'exact', head: true });
      return { totalFeedback: totalFeedback || 0, learnedRules: learnedRules || 0 };
    },
  });

  const summaryCards = [
    { label: 'Modules IA', value: stats.totalModules, sub: `${stats.activeModules} actifs`, icon: Cpu, color: 'text-purple-600 bg-purple-500/10' },
    { label: 'Messages IA (30j)', value: usageStats?.totalMessages || 0, sub: `${usageStats?.uniqueAgents || 0} agents utilisés`, icon: MessageSquare, color: 'text-blue-600 bg-blue-500/10' },
    { label: 'Score santé', value: `${stats.healthScore}%`, sub: 'Performance globale', icon: Zap, color: 'text-emerald-600 bg-emerald-500/10' },
    { label: 'Auto-apprentissage', value: feedbackStats?.learnedRules || 0, sub: `${feedbackStats?.totalFeedback || 0} feedbacks`, icon: Brain, color: 'text-amber-600 bg-amber-500/10' },
  ];

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-foreground">Intelligence Artificielle</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {summaryCards.map((card, i) => (
          <motion.div key={card.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <Card><CardContent className="p-4"><div className="flex items-center gap-3"><div className={`w-10 h-10 rounded-xl flex items-center justify-center ${card.color}`}><card.icon className="w-5 h-5" /></div><div><p className="text-lg font-bold text-foreground">{card.value}</p><p className="text-[10px] text-muted-foreground">{card.label}</p><p className="text-[9px] text-muted-foreground/70">{card.sub}</p></div></div></CardContent></Card>
          </motion.div>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><Cpu className="w-4 h-4" /> Modules IA ({modules.length})</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {modules.map(mod => (
              <div key={mod.id} className="flex items-center gap-3 p-3 rounded-xl bg-secondary/30 border border-border/50">
                <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center text-xs', getCategoryColor(mod.category))}><Brain className="w-4 h-4" /></div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{mod.name}</p>
                  <p className="text-[10px] text-muted-foreground">{getCategoryLabel(mod.category)} · {mod.metrics.successRate}% succès</p>
                </div>
                <Badge variant={mod.status === 'active' ? 'default' : 'secondary'} className="text-[9px] shrink-0">{mod.status === 'active' ? 'Actif' : mod.status === 'idle' ? 'Veille' : 'Off'}</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><Bot className="w-4 h-4" /> Agents IA</CardTitle></CardHeader>
        <CardContent>
          {agentsLoading ? <p className="text-sm text-muted-foreground">Chargement...</p> : (
            <div className="rounded-xl border border-border overflow-hidden">
              <Table>
                <TableHeader><TableRow><TableHead>Agent</TableHead><TableHead>Catégorie</TableHead><TableHead>Premium</TableHead><TableHead>Msgs gratuits/j</TableHead><TableHead>Statut</TableHead></TableRow></TableHeader>
                <TableBody>
                  {!agents?.length ? (
                    <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Aucun agent</TableCell></TableRow>
                  ) : agents.map(agent => (
                    <TableRow key={agent.id}>
                      <TableCell className="font-medium text-sm">{agent.icon} {agent.name}</TableCell>
                      <TableCell><Badge variant="secondary" className="text-[10px]">{agent.category}</Badge></TableCell>
                      <TableCell>{agent.is_premium ? <Badge className="text-[10px] bg-amber-500/10 text-amber-700">Premium</Badge> : <span className="text-xs text-muted-foreground">Gratuit</span>}</TableCell>
                      <TableCell className="text-sm">{agent.free_messages_per_day}</TableCell>
                      <TableCell><Badge variant={agent.is_active ? 'default' : 'secondary'} className="text-[10px]">{agent.is_active ? 'Actif' : 'Inactif'}</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
