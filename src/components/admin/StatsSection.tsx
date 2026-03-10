import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Users, Activity, Eye, MessageSquare, TrendingUp, DollarSign, CreditCard, Clock } from 'lucide-react';
import { motion } from 'framer-motion';

export function StatsSection() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ['admin-full-stats'],
    queryFn: async () => {
      const [usersRes, postsRes, ordersRes, activeUsersRes, commentsRes, likesRes] = await Promise.all([
        supabase.from('profiles').select('id', { count: 'exact', head: true }),
        supabase.from('posts').select('id', { count: 'exact', head: true }),
        supabase.from('orders').select('id, total, status, created_at'),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).gte('updated_at', new Date(Date.now() - 7 * 86400000).toISOString()),
        supabase.from('comments').select('id', { count: 'exact', head: true }),
        supabase.from('likes').select('id', { count: 'exact', head: true }),
      ]);
      const orders = ordersRes.data || [];
      const totalRevenue = orders.filter(o => o.status !== 'cancelled' && o.status !== 'refunded').reduce((sum, o) => sum + (o.total || 0), 0);
      const monthlyOrders = orders.filter(o => {
        const d = new Date(o.created_at); const now = new Date();
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      });
      const monthlyRevenue = monthlyOrders.filter(o => o.status !== 'cancelled' && o.status !== 'refunded').reduce((sum, o) => sum + (o.total || 0), 0);
      return {
        totalUsers: usersRes.count || 0, totalPosts: postsRes.count || 0,
        totalRevenue, monthlyRevenue, totalOrders: orders.length,
        monthlyOrders: monthlyOrders.length, activeUsers7d: activeUsersRes.count || 0,
        totalComments: commentsRes.count || 0, totalLikes: likesRes.count || 0,
      };
    },
  });

  if (isLoading) return <div className="text-center py-12 text-muted-foreground">Chargement...</div>;

  const cards = [
    { label: 'Utilisateurs total', value: stats?.totalUsers || 0, icon: Users, color: 'text-blue-600 bg-blue-500/10' },
    { label: 'Actifs (7j)', value: stats?.activeUsers7d || 0, icon: Activity, color: 'text-emerald-600 bg-emerald-500/10' },
    { label: 'Publications', value: stats?.totalPosts || 0, icon: Eye, color: 'text-purple-600 bg-purple-500/10' },
    { label: 'Commentaires', value: stats?.totalComments || 0, icon: MessageSquare, color: 'text-blue-600 bg-blue-500/10' },
    { label: 'Likes', value: stats?.totalLikes || 0, icon: TrendingUp, color: 'text-pink-600 bg-pink-500/10' },
    { label: 'Revenus total', value: `${(stats?.totalRevenue || 0).toFixed(2)}€`, icon: DollarSign, color: 'text-emerald-600 bg-emerald-500/10' },
    { label: 'Revenus ce mois', value: `${(stats?.monthlyRevenue || 0).toFixed(2)}€`, icon: TrendingUp, color: 'text-amber-600 bg-amber-500/10' },
    { label: 'Commandes total', value: stats?.totalOrders || 0, icon: CreditCard, color: 'text-blue-600 bg-blue-500/10' },
    { label: 'Commandes ce mois', value: stats?.monthlyOrders || 0, icon: Clock, color: 'text-purple-600 bg-purple-500/10' },
  ];

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-foreground">Statistiques détaillées</h2>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map((card, i) => (
          <motion.div key={card.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
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
