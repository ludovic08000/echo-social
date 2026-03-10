import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Users, FileText, DollarSign, Flag, CreditCard, MessageSquare } from 'lucide-react';
import { motion } from 'framer-motion';

export function DashboardSection() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ['admin-dashboard-stats'],
    queryFn: async () => {
      const [usersRes, postsRes, ordersRes, reportsRes, agentUsageRes] = await Promise.all([
        supabase.from('profiles').select('id', { count: 'exact', head: true }),
        supabase.from('posts').select('id', { count: 'exact', head: true }),
        supabase.from('orders').select('id, total, status, created_at'),
        supabase.from('abuse_reports').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('ai_agent_usage').select('id, message_count').gte('usage_date', new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]),
      ]);
      const orders = ordersRes.data || [];
      const totalRevenue = orders.filter(o => o.status !== 'cancelled' && o.status !== 'refunded').reduce((sum, o) => sum + (o.total || 0), 0);
      const agentMessages = (agentUsageRes.data || []).reduce((sum, u) => sum + (u.message_count || 0), 0);
      return {
        totalUsers: usersRes.count || 0,
        totalPosts: postsRes.count || 0,
        totalRevenue,
        pendingReports: reportsRes.count || 0,
        totalOrders: orders.length,
        agentMessages7d: agentMessages,
      };
    },
  });

  if (isLoading) return <div className="text-center py-12 text-muted-foreground">Chargement...</div>;

  const cards = [
    { label: 'Utilisateurs', value: stats?.totalUsers || 0, icon: Users, color: 'text-blue-600 bg-blue-500/10' },
    { label: 'Publications', value: stats?.totalPosts || 0, icon: FileText, color: 'text-purple-600 bg-purple-500/10' },
    { label: 'Revenus total', value: `${(stats?.totalRevenue || 0).toFixed(2)}€`, icon: DollarSign, color: 'text-emerald-600 bg-emerald-500/10' },
    { label: 'Signalements en attente', value: stats?.pendingReports || 0, icon: Flag, color: 'text-amber-600 bg-amber-500/10' },
    { label: 'Commandes', value: stats?.totalOrders || 0, icon: CreditCard, color: 'text-blue-600 bg-blue-500/10' },
    { label: 'Messages IA (7j)', value: stats?.agentMessages7d || 0, icon: MessageSquare, color: 'text-purple-600 bg-purple-500/10' },
  ];

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-foreground">Vue d'ensemble</h2>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map((card, i) => (
          <motion.div key={card.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${card.color}`}>
                    <card.icon className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-lg font-bold text-foreground">{card.value}</p>
                    <p className="text-[10px] text-muted-foreground">{card.label}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
