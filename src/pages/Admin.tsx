import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { 
  Shield, Users, Ban, Activity, DollarSign, AlertTriangle, 
  Search, RefreshCw, Eye, UserX, Globe, Clock, TrendingUp,
  LayoutDashboard, FileText, Flag, BarChart3, CreditCard, Lock, Settings,
  ChevronRight, MessageSquare, Brain, Bot, Cpu, Zap, Archive, Download, Mail
} from 'lucide-react';
import { getAIModules, getAIEngineStats, getCategoryLabel, getCategoryColor } from '@/lib/aiEngine';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';

function useIsAdmin() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['is-admin', user?.id],
    queryFn: async () => {
      if (!user) return false;
      const { data } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .eq('role', 'admin')
        .maybeSingle();
      return !!data;
    },
    enabled: !!user,
  });
}

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'users', label: 'Utilisateurs', icon: Users },
  { key: 'posts', label: 'Publications', icon: FileText },
  { key: 'reports', label: 'Signalements', icon: Flag },
  { key: 'verifications', label: 'Vérifications ID', icon: Shield },
  { key: 'archives', label: 'Archives Usurpation', icon: Archive },
  { key: 'stats', label: 'Statistiques', icon: BarChart3 },
  { key: 'subscriptions', label: 'Abonnements', icon: CreditCard },
  { key: 'ai', label: 'Intelligence Artificielle', icon: Brain },
  { key: 'zeus', label: '⚡ Console Zeus', icon: Zap },
  { key: 'security', label: 'Sécurité', icon: Lock },
  { key: 'settings', label: 'Paramètres', icon: Settings },
] as const;

type AdminSection = typeof NAV_ITEMS[number]['key'];

// ─── DASHBOARD ───
function DashboardSection() {
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

// ─── UTILISATEURS ───
function UsersSection() {
  const [search, setSearch] = useState('');
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const { data: users, isLoading } = useQuery({
    queryKey: ['admin-users', search],
    queryFn: async () => {
      let query = supabase.from('profiles').select('user_id, name, avatar_url, city, created_at, profile_type').order('created_at', { ascending: false }).limit(50);
      if (search.trim()) query = query.ilike('name', `%${search}%`);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });

  const banUser = useMutation({
    mutationFn: async (userId: string) => {
      if (!user) throw new Error('Non authentifié');
      const { error } = await supabase.from('banned_users').insert({ user_id: userId, reason: 'Banni par admin', banned_by: user.id });
      if (error) throw error;
    },
    onSuccess: () => { toast({ title: '🚫 Utilisateur banni' }); queryClient.invalidateQueries({ queryKey: ['admin-users'] }); },
    onError: (e: any) => toast({ title: 'Erreur', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-foreground">Utilisateurs</h2>
        <Badge variant="secondary">{users?.length || 0} résultats</Badge>
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input placeholder="Rechercher un utilisateur..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
      </div>
      <div className="rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nom</TableHead>
              <TableHead>Ville</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Inscrit le</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : !users?.length ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Aucun utilisateur</TableCell></TableRow>
            ) : users.map(u => (
              <TableRow key={u.user_id}>
                <TableCell className="font-medium text-sm">{u.name}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{u.city || '-'}</TableCell>
                <TableCell><Badge variant="secondary" className="text-[10px]">{u.profile_type || 'user'}</Badge></TableCell>
                <TableCell className="text-xs text-muted-foreground">{format(new Date(u.created_at), 'dd/MM/yyyy', { locale: fr })}</TableCell>
                <TableCell>
                  <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => banUser.mutate(u.user_id)}>
                    <Ban className="w-3 h-3 mr-1" /> Bannir
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─── PUBLICATIONS ───
function PostsSection() {
  const { data: posts, isLoading } = useQuery({
    queryKey: ['admin-posts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('posts')
        .select('id, body, image_url, created_at, user_id')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      const userIds = [...new Set(data?.map(p => p.user_id) || [])];
      const { data: profiles } = await supabase.from('profiles').select('user_id, name').in('user_id', userIds);
      return data?.map(p => ({ ...p, author: profiles?.find(pr => pr.user_id === p.user_id)?.name || 'Inconnu' })) || [];
    },
  });

  const deletePost = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('posts').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => toast({ title: 'Publication supprimée' }),
  });

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-foreground">Publications récentes</h2>
      <div className="rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Auteur</TableHead>
              <TableHead>Contenu</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : !posts?.length ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Aucune publication</TableCell></TableRow>
            ) : posts.map(p => (
              <TableRow key={p.id}>
                <TableCell className="font-medium text-sm">{p.author}</TableCell>
                <TableCell className="text-xs max-w-[250px] truncate">{p.body}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{format(new Date(p.created_at), 'dd/MM HH:mm', { locale: fr })}</TableCell>
                <TableCell>
                  <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => deletePost.mutate(p.id)}>
                    Supprimer
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─── SIGNALEMENTS ───
function ReportsSection() {
  const queryClient = useQueryClient();

  const { data: reports, isLoading } = useQuery({
    queryKey: ['admin-reports'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('abuse_reports')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      const userIds = [...new Set([...(data?.map(r => r.reporter_id) || []), ...(data?.map(r => r.reported_user_id) || [])])];
      const { data: profiles } = await supabase.from('profiles').select('user_id, name').in('user_id', userIds);
      return data?.map(r => ({
        ...r,
        reporterName: profiles?.find(p => p.user_id === r.reporter_id)?.name || r.reporter_id.slice(0, 8),
        reportedName: profiles?.find(p => p.user_id === r.reported_user_id)?.name || r.reported_user_id.slice(0, 8),
      })) || [];
    },
  });

  const updateReport = useMutation({
    mutationFn: async ({ id, status, resolution }: { id: string; status: string; resolution: string }) => {
      const { error } = await supabase.from('abuse_reports').update({ status, resolution, reviewed_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => { toast({ title: 'Signalement traité' }); queryClient.invalidateQueries({ queryKey: ['admin-reports'] }); },
  });

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-foreground">Signalements</h2>
      <div className="rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Signalé par</TableHead>
              <TableHead>Utilisateur signalé</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : !reports?.length ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Aucun signalement</TableCell></TableRow>
            ) : reports.map(r => (
              <TableRow key={r.id}>
                <TableCell className="text-sm">{r.reporterName}</TableCell>
                <TableCell className="text-sm font-medium">{r.reportedName}</TableCell>
                <TableCell><Badge variant="secondary" className="text-[10px]">{r.report_type}</Badge></TableCell>
                <TableCell>
                  <Badge variant={r.status === 'pending' ? 'destructive' : 'secondary'} className="text-[10px]">
                    {r.status === 'pending' ? 'En attente' : r.status === 'resolved' ? 'Résolu' : r.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{format(new Date(r.created_at), 'dd/MM HH:mm', { locale: fr })}</TableCell>
                <TableCell>
                  {r.status === 'pending' && (
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => updateReport.mutate({ id: r.id, status: 'resolved', resolution: 'Approuvé par admin' })}>
                        Résoudre
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => updateReport.mutate({ id: r.id, status: 'dismissed', resolution: 'Rejeté' })}>
                        Rejeter
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─── STATISTIQUES ───
function StatsSection() {
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
        totalUsers: usersRes.count || 0,
        totalPosts: postsRes.count || 0,
        totalRevenue, monthlyRevenue,
        totalOrders: orders.length,
        monthlyOrders: monthlyOrders.length,
        activeUsers7d: activeUsersRes.count || 0,
        totalComments: commentsRes.count || 0,
        totalLikes: likesRes.count || 0,
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

// ─── ABONNEMENTS / PAIEMENTS ───
function SubscriptionsSection() {
  const { data: orders, isLoading } = useQuery({
    queryKey: ['admin-orders'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('id, order_number, buyer_id, total, commission_amount, status, created_at')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      const buyerIds = [...new Set(data?.map(o => o.buyer_id) || [])];
      const { data: profiles } = buyerIds.length > 0
        ? await supabase.from('profiles').select('user_id, name').in('user_id', buyerIds)
        : { data: [] };
      return data?.map(o => ({ ...o, buyerName: profiles?.find(p => p.user_id === o.buyer_id)?.name || o.buyer_id.slice(0, 8) })) || [];
    },
  });

  const statusColor = (s: string) => {
    if (s === 'delivered' || s === 'paid') return 'bg-emerald-500/10 text-emerald-700';
    if (s === 'cancelled' || s === 'refunded') return 'bg-destructive/10 text-destructive';
    if (s === 'shipped') return 'bg-blue-500/10 text-blue-700';
    return 'bg-amber-500/10 text-amber-700';
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-foreground">Paiements & Commandes</h2>
      <div className="rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>N° Commande</TableHead>
              <TableHead>Acheteur</TableHead>
              <TableHead>Total</TableHead>
              <TableHead>Commission</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : !orders?.length ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Aucune commande</TableCell></TableRow>
            ) : orders.map(o => (
              <TableRow key={o.id}>
                <TableCell className="font-mono text-xs">{o.order_number}</TableCell>
                <TableCell className="text-sm">{o.buyerName}</TableCell>
                <TableCell className="text-sm font-semibold">{o.total.toFixed(2)}€</TableCell>
                <TableCell className="text-xs text-muted-foreground">{o.commission_amount.toFixed(2)}€</TableCell>
                <TableCell><Badge className={cn('text-[10px]', statusColor(o.status))}>{o.status}</Badge></TableCell>
                <TableCell className="text-xs text-muted-foreground">{format(new Date(o.created_at), 'dd/MM/yyyy', { locale: fr })}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─── SÉCURITÉ ───
function SecuritySection() {
  const [search, setSearch] = useState('');
  const [newIp, setNewIp] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [reason, setReason] = useState('');
  const [emailReason, setEmailReason] = useState('');
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const { data: logs, isLoading: logsLoading, refetch: refetchLogs } = useQuery({
    queryKey: ['security-logs'],
    queryFn: async () => {
      const { data, error } = await supabase.from('security_logs').select('*').order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      return data;
    },
  });

  const { data: bannedIps } = useQuery({
    queryKey: ['banned-ips'],
    queryFn: async () => {
      const { data, error } = await supabase.from('banned_ips').select('*').eq('is_active', true).order('banned_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: bannedEmails } = useQuery({
    queryKey: ['banned-emails'],
    queryFn: async () => {
      const { data, error } = await supabase.from('banned_emails').select('*').eq('is_active', true).order('banned_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: bannedUsers } = useQuery({
    queryKey: ['banned-users-security'],
    queryFn: async () => {
      const { data, error } = await supabase.from('banned_users').select('*').eq('is_active', true).order('banned_at', { ascending: false });
      if (error) throw error;
      if (!data?.length) return [];
      const userIds = data.map(b => b.user_id);
      const { data: profiles } = await supabase.from('profiles').select('user_id, name').in('user_id', userIds);
      return data.map(b => ({ ...b, profile: profiles?.find(p => p.user_id === b.user_id) }));
    },
  });

  const { data: suspiciousActivity } = useQuery({
    queryKey: ['suspicious-activity'],
    queryFn: async () => {
      const { data: multiAccounts } = await supabase
        .from('device_fingerprints')
        .select('fingerprint_hash, ip_address, user_id, last_seen_at')
        .order('last_seen_at', { ascending: false })
        .limit(50);

      const { data: flagged } = await supabase
        .from('trust_scores')
        .select('user_id, trust_score, is_flagged, flag_reason, reports_received')
        .eq('is_flagged', true)
        .limit(20);

      const flaggedIds = flagged?.map(f => f.user_id) || [];
      const { data: flaggedProfiles } = flaggedIds.length > 0
        ? await supabase.from('profiles').select('user_id, name').in('user_id', flaggedIds)
        : { data: [] };

      const ipCounts: Record<string, string[]> = {};
      multiAccounts?.forEach(d => {
        if (d.ip_address) {
          if (!ipCounts[d.ip_address]) ipCounts[d.ip_address] = [];
          if (!ipCounts[d.ip_address].includes(d.user_id)) ipCounts[d.ip_address].push(d.user_id);
        }
      });
      const suspiciousIps = Object.entries(ipCounts).filter(([, users]) => users.length > 2);

      return {
        suspiciousIps,
        flaggedUsers: (flagged || []).map(f => ({
          ...f,
          name: flaggedProfiles?.find(p => p.user_id === f.user_id)?.name || f.user_id.slice(0, 8),
        })),
      };
    },
  });

  const banIp = useMutation({
    mutationFn: async () => {
      if (!newIp.trim() || !user) throw new Error('IP requise');
      const { error } = await supabase.from('banned_ips').insert({ ip_address: newIp.trim(), reason: reason.trim() || null, banned_by: user.id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: '🚫 IP bannie' }); setNewIp(''); setReason('');
      queryClient.invalidateQueries({ queryKey: ['banned-ips'] });
    },
    onError: (e: any) => toast({ title: 'Erreur', description: e.message, variant: 'destructive' }),
  });

  const banEmail = useMutation({
    mutationFn: async () => {
      if (!newEmail.trim() || !user) throw new Error('Email requis');
      const { error } = await supabase.from('banned_emails').insert({ 
        email: newEmail.trim().toLowerCase(), 
        reason: emailReason.trim() || 'Usurpation d\'identité', 
        banned_by: user.id 
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: '🚫 Email banni' }); setNewEmail(''); setEmailReason('');
      queryClient.invalidateQueries({ queryKey: ['banned-emails'] });
    },
    onError: (e: any) => toast({ title: 'Erreur', description: e.message, variant: 'destructive' }),
  });

  const unbanIp = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('banned_ips').update({ is_active: false }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => { toast({ title: 'IP débannie' }); queryClient.invalidateQueries({ queryKey: ['banned-ips'] }); },
  });

  const unbanEmail = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('banned_emails').update({ is_active: false }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => { toast({ title: 'Email débanni' }); queryClient.invalidateQueries({ queryKey: ['banned-emails'] }); },
  });

  const unbanUser = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('banned_users').update({ is_active: false }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => { toast({ title: 'Utilisateur débanni' }); queryClient.invalidateQueries({ queryKey: ['banned-users-security'] }); },
  });

  // Full block: ban user + IP + email simultaneously
  const fullBlock = useMutation({
    mutationFn: async ({ userId, ipAddress, email }: { userId: string; ipAddress?: string; email?: string }) => {
      if (!user) throw new Error('Non connecté');
      await supabase.from('banned_users').insert({ user_id: userId, reason: 'Usurpation d\'identité - blocage complet', banned_by: user.id });
      if (ipAddress) {
        await supabase.from('banned_ips').insert({ ip_address: ipAddress, reason: 'Usurpation d\'identité', banned_by: user.id });
      }
      if (email) {
        await supabase.from('banned_emails').insert({ email: email.toLowerCase(), reason: 'Usurpation d\'identité', banned_by: user.id });
      }
    },
    onSuccess: () => {
      toast({ title: '🔒 Blocage complet', description: 'Compte, IP et email bannis.' });
      queryClient.invalidateQueries({ queryKey: ['banned-users-security'] });
      queryClient.invalidateQueries({ queryKey: ['banned-ips'] });
      queryClient.invalidateQueries({ queryKey: ['banned-emails'] });
    },
    onError: (e: any) => toast({ title: 'Erreur', description: e.message, variant: 'destructive' }),
  });

  const filteredLogs = logs?.filter(l =>
    !search.trim() ||
    l.event_type?.toLowerCase().includes(search.toLowerCase()) ||
    l.ip_address?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-foreground">Sécurité & Anti-Usurpation</h2>

      {/* Protection summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'IPs bannies', value: bannedIps?.length || 0, icon: Globe, color: 'text-red-600 bg-red-500/10' },
          { label: 'Emails bannis', value: bannedEmails?.length || 0, icon: Lock, color: 'text-orange-600 bg-orange-500/10' },
          { label: 'Comptes bannis', value: bannedUsers?.length || 0, icon: UserX, color: 'text-destructive bg-destructive/10' },
          { label: 'IPs suspectes', value: suspiciousActivity?.suspiciousIps.length || 0, icon: AlertTriangle, color: 'text-amber-600 bg-amber-500/10' },
        ].map((card, i) => (
          <motion.div key={card.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center', card.color)}>
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

      {/* Suspicious IPs */}
      {suspiciousActivity && suspiciousActivity.suspiciousIps.length > 0 && (
        <Card className="border-amber-500/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-500" /> IPs suspectes (multi-comptes)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {suspiciousActivity.suspiciousIps.map(([ip, users]) => (
                <div key={ip} className="flex items-center justify-between p-2 rounded-lg bg-destructive/5 border border-destructive/20">
                  <div>
                    <span className="font-mono text-sm">{ip}</span>
                    <span className="text-xs text-muted-foreground ml-2">{users.length} comptes</span>
                  </div>
                  <div className="flex gap-1">
                    <Badge variant="destructive" className="text-[10px]">Suspect</Badge>
                    <Button size="sm" variant="destructive" className="h-6 text-[10px]" onClick={() => {
                      setNewIp(ip); setReason('Multi-comptes détectés');
                      banIp.mutate();
                    }}>
                      <Ban className="w-3 h-3 mr-1" /> Bannir IP
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Flagged users with full block */}
      {suspiciousActivity && suspiciousActivity.flaggedUsers.length > 0 && (
        <Card className="border-red-500/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2"><Shield className="w-4 h-4 text-red-500" /> Utilisateurs signalés — Usurpation potentielle</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {suspiciousActivity.flaggedUsers.map(u => (
                <div key={u.user_id} className="flex items-center justify-between p-2 rounded-lg bg-amber-500/5 border border-amber-500/20">
                  <div>
                    <span className="text-sm font-medium">{u.name}</span>
                    <span className="text-xs text-muted-foreground ml-2">Score: {u.trust_score}/100</span>
                    <span className="text-xs text-destructive ml-2">{u.flag_reason}</span>
                  </div>
                  <div className="flex gap-1">
                    <Badge variant="secondary" className="text-[10px]">{u.reports_received} signalement(s)</Badge>
                    <Button size="sm" variant="destructive" className="h-6 text-[10px]" onClick={() => fullBlock.mutate({ userId: u.user_id })}>
                      <Lock className="w-3 h-3 mr-1" /> Blocage total
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Ban IP */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><Globe className="w-4 h-4" /> Bannir une IP</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input placeholder="Adresse IP" value={newIp} onChange={e => setNewIp(e.target.value)} className="flex-1" />
            <Input placeholder="Raison" value={reason} onChange={e => setReason(e.target.value)} className="flex-1" />
            <Button onClick={() => banIp.mutate()} disabled={!newIp.trim()}><Ban className="w-4 h-4 mr-1" /> Bannir</Button>
          </div>
          {bannedIps && bannedIps.length > 0 && (
            <div className="space-y-1">
              {bannedIps.map(ip => (
                <div key={ip.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-secondary/30">
                  <div>
                    <span className="font-mono text-sm">{ip.ip_address}</span>
                    <span className="text-xs text-muted-foreground ml-2">{ip.reason || '-'}</span>
                  </div>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => unbanIp.mutate(ip.id)}>Débannir</Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Ban Email */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><Lock className="w-4 h-4" /> Bannir une adresse email</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input placeholder="email@example.com" value={newEmail} onChange={e => setNewEmail(e.target.value)} className="flex-1" />
            <Input placeholder="Raison" value={emailReason} onChange={e => setEmailReason(e.target.value)} className="flex-1" />
            <Button onClick={() => banEmail.mutate()} disabled={!newEmail.trim()}><Ban className="w-4 h-4 mr-1" /> Bannir</Button>
          </div>
          {bannedEmails && bannedEmails.length > 0 && (
            <div className="space-y-1">
              {bannedEmails.map(e => (
                <div key={e.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-secondary/30">
                  <div>
                    <span className="text-sm">{e.email}</span>
                    <span className="text-xs text-muted-foreground ml-2">{e.reason || '-'}</span>
                  </div>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => unbanEmail.mutate(e.id)}>Débannir</Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Banned users */}
      {bannedUsers && bannedUsers.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2"><UserX className="w-4 h-4" /> Utilisateurs bannis</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {bannedUsers.map(b => (
                <div key={b.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-secondary/30">
                  <div>
                    <span className="text-sm font-medium">{(b as any).profile?.name || b.user_id.slice(0, 8)}</span>
                    <span className="text-xs text-muted-foreground ml-2">{b.reason || '-'}</span>
                  </div>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => unbanUser.mutate(b.id)}>Débannir</Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Security Logs */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><Activity className="w-4 h-4" /> Logs de connexion</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input placeholder="Rechercher..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
            </div>
            <Button variant="outline" size="icon" onClick={() => refetchLogs()}><RefreshCw className="w-4 h-4" /></Button>
          </div>
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>Détails</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logsLoading ? (
                  <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Chargement...</TableCell></TableRow>
                ) : !filteredLogs?.length ? (
                  <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Aucun log</TableCell></TableRow>
                ) : filteredLogs.slice(0, 30).map(log => (
                  <TableRow key={log.id}>
                    <TableCell>
                      <Badge variant={log.event_type?.includes('attack') || log.event_type?.includes('suspicious') ? 'destructive' : 'secondary'} className="text-[10px]">
                        {log.event_type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs font-mono">{log.ip_address || '-'}</TableCell>
                    <TableCell className="text-xs max-w-[200px] truncate">{JSON.stringify(log.details) || '-'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{format(new Date(log.created_at), 'dd/MM HH:mm', { locale: fr })}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── PARAMÈTRES ───
function SettingsSection() {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-foreground">Paramètres</h2>
      <div className="grid gap-4">
        <Card>
          <CardContent className="p-6">
            <h3 className="font-semibold text-foreground mb-2">Maintenance</h3>
            <p className="text-sm text-muted-foreground mb-4">Activer le mode maintenance pour empêcher l'accès aux utilisateurs.</p>
            <Button variant="outline">Activer la maintenance</Button>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <h3 className="font-semibold text-foreground mb-2">Cache IA</h3>
            <p className="text-sm text-muted-foreground mb-4">Vider le cache de modération IA pour forcer le recalcul.</p>
            <Button variant="outline" onClick={async () => {
              await supabase.rpc('cleanup_ai_cache');
              toast({ title: 'Cache vidé' });
            }}>Vider le cache</Button>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <h3 className="font-semibold text-foreground mb-2">Plateforme</h3>
            <p className="text-sm text-muted-foreground">Version ForSure Admin v1.0</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── INTELLIGENCE ARTIFICIELLE ───
function AISection() {
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
      const { data } = await supabase
        .from('ai_agent_usage')
        .select('agent_id, message_count, usage_date')
        .gte('usage_date', new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]);
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

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {summaryCards.map((card, i) => (
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
                    <p className="text-[9px] text-muted-foreground/70">{card.sub}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* AI Modules */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><Cpu className="w-4 h-4" /> Modules IA ({modules.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {modules.map(mod => (
              <div key={mod.id} className="flex items-center gap-3 p-3 rounded-xl bg-secondary/30 border border-border/50">
                <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center text-xs', getCategoryColor(mod.category))}>
                  <Brain className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{mod.name}</p>
                  <p className="text-[10px] text-muted-foreground">{getCategoryLabel(mod.category)} · {mod.metrics.successRate}% succès</p>
                </div>
                <Badge variant={mod.status === 'active' ? 'default' : 'secondary'} className="text-[9px] shrink-0">
                  {mod.status === 'active' ? 'Actif' : mod.status === 'idle' ? 'Veille' : 'Off'}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* AI Agents */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><Bot className="w-4 h-4" /> Agents IA</CardTitle>
        </CardHeader>
        <CardContent>
          {agentsLoading ? (
            <p className="text-sm text-muted-foreground">Chargement...</p>
          ) : (
            <div className="rounded-xl border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Catégorie</TableHead>
                    <TableHead>Premium</TableHead>
                    <TableHead>Msgs gratuits/j</TableHead>
                    <TableHead>Statut</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!agents?.length ? (
                    <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Aucun agent</TableCell></TableRow>
                  ) : agents.map(agent => (
                    <TableRow key={agent.id}>
                      <TableCell className="font-medium text-sm">{agent.icon} {agent.name}</TableCell>
                      <TableCell><Badge variant="secondary" className="text-[10px]">{agent.category}</Badge></TableCell>
                      <TableCell>{agent.is_premium ? <Badge className="text-[10px] bg-amber-500/10 text-amber-700">Premium</Badge> : <span className="text-xs text-muted-foreground">Gratuit</span>}</TableCell>
                      <TableCell className="text-sm">{agent.free_messages_per_day}</TableCell>
                      <TableCell>
                        <Badge variant={agent.is_active ? 'default' : 'secondary'} className="text-[10px]">
                          {agent.is_active ? 'Actif' : 'Inactif'}
                        </Badge>
                      </TableCell>
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

// ─── VÉRIFICATIONS D'IDENTITÉ ───
function VerificationsSection() {
  const queryClient = useQueryClient();
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [analysisResults, setAnalysisResults] = useState<Record<string, any>>({});

  const { data: verifications, isLoading } = useQuery({
    queryKey: ['admin-verifications'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('identity_verifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      const userIds = [...new Set([...(data?.map(v => v.reported_user_id) || []), ...(data?.map(v => v.reporter_id) || [])])];
      const { data: profiles } = userIds.length > 0
        ? await supabase.from('profiles').select('user_id, name, avatar_url').in('user_id', userIds)
        : { data: [] };
      return data?.map(v => ({
        ...v,
        reportedName: profiles?.find(p => p.user_id === v.reported_user_id)?.name || v.reported_user_id.slice(0, 8),
        reporterName: profiles?.find(p => p.user_id === v.reporter_id)?.name || v.reporter_id.slice(0, 8),
        reportedAvatar: profiles?.find(p => p.user_id === v.reported_user_id)?.avatar_url,
      })) || [];
    },
  });

  const updateVerification = useMutation({
    mutationFn: async ({ id, status, note }: { id: string; status: string; note?: string }) => {
      const updates: any = { status, updated_at: new Date().toISOString() };
      if (status === 'verified') updates.verified_at = new Date().toISOString();
      if (note) updates.admin_note = note;
      const { error } = await supabase.from('identity_verifications').update(updates).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: 'Vérification mise à jour' });
      queryClient.invalidateQueries({ queryKey: ['admin-verifications'] });
    },
  });

  const deleteAccount = useMutation({
    mutationFn: async ({ id, userId }: { id: string; userId: string }) => {
      await supabase.from('identity_verifications').update({ status: 'deleted', auto_deleted: true, updated_at: new Date().toISOString() }).eq('id', id);
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase.from('banned_users').insert({ user_id: userId, reason: 'Faux compte non vérifié', banned_by: user.id });
      }
    },
    onSuccess: () => {
      toast({ title: '🚫 Compte supprimé/banni', description: 'Le faux compte a été banni.' });
      queryClient.invalidateQueries({ queryKey: ['admin-verifications'] });
    },
  });

  const archiveUsurper = async (v: any) => {
    try {
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      if (!currentUser) return;

      // Gather evidence: profile snapshot
      const { data: profile } = await supabase.from('profiles').select('*').eq('user_id', v.reported_user_id).maybeSingle();
      
      // Gather IPs from device fingerprints
      const { data: fingerprints } = await supabase.from('device_fingerprints').select('*').eq('user_id', v.reported_user_id);
      const ips = [...new Set((fingerprints || []).map(f => f.ip_address).filter(Boolean))] as string[];
      
      // Gather connection logs
      const { data: connLogs } = await supabase.from('security_logs').select('*').or(`details->>user_id.eq.${v.reported_user_id},ip_address.in.(${ips.join(',')})`).order('created_at', { ascending: false }).limit(50);

      // Generate case number
      const caseNumber = `USR-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

      const { error } = await supabase.from('identity_theft_archives').insert({
        usurper_user_id: v.reported_user_id,
        usurper_name: v.reportedName || profile?.name,
        usurper_email: v.reported_email || null,
        usurper_avatar_url: v.reportedAvatar || profile?.avatar_url,
        usurper_bio: profile?.bio,
        victim_user_id: v.reporter_id,
        victim_name: v.reporterName,
        ip_addresses: ips,
        device_fingerprints: fingerprints || [],
        connection_logs: connLogs || [],
        profile_snapshot: profile || {},
        archived_by: currentUser.id,
        case_number: caseNumber,
        admin_notes: `Archivé depuis vérification ID #${v.id}`,
      });

      if (error) throw error;

      // Also ban the account
      await supabase.from('banned_users').insert({ user_id: v.reported_user_id, reason: `Usurpation d'identité - Dossier ${caseNumber}`, banned_by: currentUser.id });
      // Ban IPs
      for (const ip of ips) {
        try { await supabase.from('banned_ips').insert({ ip_address: ip, reason: `Usurpation - ${caseNumber}`, banned_by: currentUser.id }); } catch {}
      }

      // Update verification status
      await supabase.from('identity_verifications').update({ status: 'deleted', auto_deleted: true, updated_at: new Date().toISOString() }).eq('id', v.id);

      toast({ title: '📁 Profil archivé', description: `Dossier ${caseNumber} créé avec toutes les preuves (IPs, logs, fingerprints).` });
      queryClient.invalidateQueries({ queryKey: ['admin-verifications'] });
    } catch (e: any) {
      toast({ title: 'Erreur', description: e.message, variant: 'destructive' });
    }
  };

  const analyzePhoto = async (userId: string, avatarUrl: string) => {
    if (!avatarUrl) {
      toast({ title: 'Pas de photo', description: 'Cet utilisateur n\'a pas de photo de profil.', variant: 'destructive' });
      return;
    }
    setAnalyzing(userId);
    try {
      // userId is now derived from JWT server-side
      const [analyzeRes, compareRes] = await Promise.all([
        supabase.functions.invoke('zeus', { body: { domain: 'photo', action: 'analyze_photo', imageUrl: avatarUrl } }),
        supabase.functions.invoke('zeus', { body: { domain: 'photo', action: 'compare_photos' } }),
      ]);
      setAnalysisResults(prev => ({
        ...prev,
        [userId]: {
          analysis: analyzeRes.data?.analysis,
          comparison: compareRes.data,
        },
      }));
    } catch (e: any) {
      toast({ title: 'Erreur analyse', description: e.message, variant: 'destructive' });
    } finally {
      setAnalyzing(null);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending_verification': return <Badge variant="destructive" className="text-[10px]">En attente</Badge>;
      case 'document_submitted': return <Badge className="text-[10px] bg-amber-500/10 text-amber-700">Document soumis</Badge>;
      case 'verified': return <Badge className="text-[10px] bg-emerald-500/10 text-emerald-700">Vérifié ✅</Badge>;
      case 'deleted': return <Badge variant="secondary" className="text-[10px]">Supprimé</Badge>;
      default: return <Badge variant="secondary" className="text-[10px]">{status}</Badge>;
    }
  };

  const getRiskBadge = (score: number) => {
    if (score >= 70) return <Badge variant="destructive" className="text-[10px]">Risque élevé ({score}%)</Badge>;
    if (score >= 40) return <Badge className="text-[10px] bg-amber-500/10 text-amber-700">Risque moyen ({score}%)</Badge>;
    return <Badge className="text-[10px] bg-emerald-500/10 text-emerald-700">Faible risque ({score}%)</Badge>;
  };

  const isExpired = (deadline: string) => new Date(deadline) < new Date();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-foreground">Vérifications d'identité & Détection de faux profils</h2>
        <Badge variant="secondary">
          {verifications?.filter(v => v.status === 'pending_verification').length || 0} en attente
        </Badge>
      </div>

      {/* AI Protection Info */}
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4 flex items-start gap-3">
          <Cpu className="w-5 h-5 text-primary mt-0.5 shrink-0" />
          <div className="text-xs space-y-1">
            <p className="font-semibold text-foreground">Protection IA active</p>
            <p className="text-muted-foreground">L'IA analyse les photos de profil pour détecter les images volées, les photos stock, les générations IA et les doublons entre utilisateurs. Cliquez "🔍 Scanner" sur chaque vérification pour lancer l'analyse.</p>
          </div>
        </CardContent>
      </Card>

      {/* Expired - auto delete candidates */}
      {verifications?.filter(v => v.status === 'pending_verification' && isExpired(v.deadline_at)).map(v => (
        <Card key={`expired-${v.id}`} className="border-destructive/30 bg-destructive/5">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-destructive">⏰ Délai expiré — {v.reportedName}</p>
                <p className="text-xs text-muted-foreground">Signalé par {v.reporterName} · Délai : {format(new Date(v.deadline_at), 'dd/MM/yyyy HH:mm', { locale: fr })}</p>
              </div>
              <Button variant="destructive" size="sm" className="h-8 text-xs" onClick={() => deleteAccount.mutate({ id: v.id, userId: v.reported_user_id })}>
                <Ban className="w-3 h-3 mr-1" /> Supprimer le compte
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}

      <div className="rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Photo</TableHead>
              <TableHead>Compte signalé</TableHead>
              <TableHead>Signalé par</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead>Deadline</TableHead>
              <TableHead>Document</TableHead>
              <TableHead>Analyse IA</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : !verifications?.length ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Aucune vérification en cours</TableCell></TableRow>
            ) : verifications.map(v => {
              const result = analysisResults[v.reported_user_id];
              return (
                <TableRow key={v.id}>
                  <TableCell>
                    {v.reportedAvatar ? (
                      <img src={v.reportedAvatar} alt="" className="w-10 h-10 rounded-full object-cover" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                        <Users className="w-4 h-4 text-muted-foreground" />
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="font-medium text-sm">{v.reportedName}</TableCell>
                  <TableCell className="text-sm">{v.reporterName}</TableCell>
                  <TableCell>{getStatusBadge(v.status)}</TableCell>
                  <TableCell className={cn('text-xs', isExpired(v.deadline_at) && v.status === 'pending_verification' ? 'text-destructive font-semibold' : 'text-muted-foreground')}>
                    {format(new Date(v.deadline_at), 'dd/MM HH:mm', { locale: fr })}
                    {isExpired(v.deadline_at) && v.status === 'pending_verification' && ' ⚠️'}
                  </TableCell>
                  <TableCell>
                    {v.id_document_url ? (
                      <Button size="sm" variant="link" className="text-xs p-0 h-auto" onClick={async () => {
                        const { data } = await supabase.storage.from('id-documents').createSignedUrl(v.id_document_url, 300);
                        if (data?.signedUrl) window.open(data.signedUrl, '_blank');
                      }}>Voir</Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {result ? (
                      <div className="space-y-1">
                        {result.analysis && getRiskBadge(result.analysis.risk_score || 0)}
                        {result.comparison?.has_duplicates && (
                          <Badge variant="destructive" className="text-[10px] block w-fit">
                            ⚠️ Doublon détecté
                          </Badge>
                        )}
                        {result.analysis?.details && (
                          <p className="text-[10px] text-muted-foreground max-w-[200px] truncate" title={result.analysis.details}>
                            {result.analysis.details}
                          </p>
                        )}
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={analyzing === v.reported_user_id}
                        onClick={() => analyzePhoto(v.reported_user_id, v.reportedAvatar)}
                      >
                        {analyzing === v.reported_user_id ? (
                          <><RefreshCw className="w-3 h-3 mr-1 animate-spin" /> Analyse...</>
                        ) : (
                          <>🔍 Scanner</>
                        )}
                      </Button>
                    )}
                  </TableCell>
                  <TableCell>
                    {v.status !== 'verified' && v.status !== 'deleted' && (
                      <div className="flex gap-1 flex-wrap">
                        {v.status === 'document_submitted' && (
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => updateVerification.mutate({ id: v.id, status: 'verified' })}>
                            ✅ Valider
                          </Button>
                        )}
                        <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => deleteAccount.mutate({ id: v.id, userId: v.reported_user_id })}>
                          Supprimer
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs border-primary/30 text-primary" onClick={() => archiveUsurper(v)}>
                          <Archive className="w-3 h-3 mr-1" /> Archiver
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Detailed AI results */}
      {Object.entries(analysisResults).length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Résultats d'analyse IA détaillés</h3>
          {Object.entries(analysisResults).map(([userId, result]) => {
            const v = verifications?.find(v => v.reported_user_id === userId);
            if (!v || !result) return null;
            return (
              <Card key={userId} className="border-border">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    {v.reportedAvatar && <img src={v.reportedAvatar} alt="" className="w-12 h-12 rounded-full object-cover" />}
                    <div>
                      <p className="text-sm font-semibold">{v.reportedName}</p>
                      {result.analysis && getRiskBadge(result.analysis.risk_score || 0)}
                    </div>
                  </div>
                  {result.analysis && (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">{result.analysis.details}</p>
                      {result.analysis.reasons?.length > 0 && (
                        <ul className="text-xs text-muted-foreground list-disc pl-4">
                          {result.analysis.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}
                        </ul>
                      )}
                      <p className="text-xs">
                        Recommandation : <Badge variant={result.analysis.recommendation === 'reject' ? 'destructive' : result.analysis.recommendation === 'flag' ? 'secondary' : 'default'} className="text-[10px]">
                          {result.analysis.recommendation === 'reject' ? '❌ Rejeter' : result.analysis.recommendation === 'flag' ? '⚠️ À surveiller' : '✅ Approuver'}
                        </Badge>
                      </p>
                    </div>
                  )}
                  {result.comparison?.has_duplicates && (
                    <div className="bg-destructive/5 border border-destructive/20 rounded-lg p-3 space-y-2">
                      <p className="text-xs font-semibold text-destructive">⚠️ Photos en double détectées</p>
                      <p className="text-xs text-muted-foreground">{result.comparison.summary}</p>
                      {result.comparison.matches?.map((m: any, i: number) => (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          {m.matched_user?.avatar_url && <img src={m.matched_user.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" />}
                          <span>{m.matched_user?.name || 'Inconnu'}</span>
                          <Badge className="text-[10px]">{m.confidence}% - {m.match_type}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── ARCHIVES USURPATION D'IDENTITÉ ───
function ArchivesSection() {
  const queryClient = useQueryClient();

  const { data: archives, isLoading } = useQuery({
    queryKey: ['admin-archives'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('identity_theft_archives')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data;
    },
  });

  const updateArchive = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Record<string, any> }) => {
      const { error } = await supabase.from('identity_theft_archives').update(updates).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: 'Dossier mis à jour' });
      queryClient.invalidateQueries({ queryKey: ['admin-archives'] });
    },
  });

  const generateReport = (archive: any) => {
    const report = `
═══════════════════════════════════════════════
   DOSSIER USURPATION D'IDENTITÉ
   Réf: ${archive.case_number}
   Date: ${new Date(archive.archived_at).toLocaleDateString('fr-FR')}
═══════════════════════════════════════════════

▸ USURPATEUR
  Nom utilisé : ${archive.usurper_name || 'Non renseigné'}
  Email : ${archive.usurper_email || 'Non renseigné'}
  ID utilisateur : ${archive.usurper_user_id}

▸ VICTIME
  Nom : ${archive.victim_name || 'Non renseigné'}
  ID utilisateur : ${archive.victim_user_id || 'Non renseigné'}

▸ PREUVES NUMÉRIQUES

  Adresses IP utilisées :
${(archive.ip_addresses || []).map((ip: string) => `    • ${ip}`).join('\n') || '    Aucune IP collectée'}

  Empreintes numériques (Device Fingerprints) :
${(archive.device_fingerprints || []).map((f: any, i: number) => 
  `    [${i + 1}] Hash: ${f.fingerprint_hash || '-'} | Résolution: ${f.screen_resolution || '-'} | Timezone: ${f.timezone || '-'} | Langue: ${f.language || '-'} | Agent: ${f.user_agent || '-'} | Dernière connexion: ${f.last_seen_at || '-'}`
).join('\n') || '    Aucune empreinte collectée'}

  Logs de connexion (${(archive.connection_logs || []).length} entrées) :
${(archive.connection_logs || []).slice(0, 20).map((l: any) => 
  `    [${new Date(l.created_at).toLocaleString('fr-FR')}] ${l.event_type || '-'} | IP: ${l.ip_address || '-'} | ${JSON.stringify(l.details || {})}`
).join('\n') || '    Aucun log collecté'}

▸ SNAPSHOT DU PROFIL
${archive.profile_snapshot ? `    Nom : ${archive.profile_snapshot.name || '-'}
    Bio : ${archive.profile_snapshot.bio || '-'}
    Ville : ${archive.profile_snapshot.city || '-'}
    Créé le : ${archive.profile_snapshot.created_at || '-'}` : '    Non disponible'}

▸ NOTES ADMINISTRATEUR
  ${archive.admin_notes || 'Aucune note'}

▸ STATUT JURIDIQUE
  Plainte déposée : ${archive.legal_complaint_filed ? 'Oui' : 'Non'}
  ${archive.legal_complaint_date ? `Date de plainte : ${new Date(archive.legal_complaint_date).toLocaleDateString('fr-FR')}` : ''}
  ${archive.legal_reference ? `Référence : ${archive.legal_reference}` : ''}

═══════════════════════════════════════════════
  Généré par ForSure — ${new Date().toLocaleString('fr-FR')}
  Ce document peut être utilisé comme preuve
  dans le cadre d'une procédure judiciaire.
═══════════════════════════════════════════════
`.trim();

    const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dossier-usurpation-${archive.case_number}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: '📄 Rapport téléchargé', description: `Dossier ${archive.case_number}` });
  };

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [legalRef, setLegalRef] = useState('');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-foreground">Archives Usurpation d'Identité</h2>
        <Badge variant="secondary">{archives?.length || 0} dossier(s)</Badge>
      </div>

      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4 flex items-start gap-3">
          <Archive className="w-5 h-5 text-primary mt-0.5 shrink-0" />
          <div className="text-xs space-y-1">
            <p className="font-semibold text-foreground">Dossiers juridiques</p>
            <p className="text-muted-foreground">Chaque archive contient les preuves complètes (IPs, logs de connexion, empreintes numériques, snapshot du profil) pouvant être utilisées en cas de dépôt de plainte pour usurpation d'identité. Téléchargez le rapport complet en cliquant sur "📄 Rapport".</p>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Chargement...</p>
      ) : !archives?.length ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Aucun dossier archivé</p>
      ) : archives.map(archive => (
        <Card key={archive.id} className="border-border">
          <CardContent className="p-4 space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {archive.usurper_avatar_url && <img src={archive.usurper_avatar_url} alt="" className="w-10 h-10 rounded-full object-cover border-2 border-destructive/30" />}
                <div>
                  <p className="text-sm font-semibold text-foreground">{archive.usurper_name || 'Inconnu'}</p>
                  <p className="text-[10px] text-muted-foreground font-mono">{archive.case_number}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {archive.legal_complaint_filed && <Badge className="text-[10px] bg-emerald-500/10 text-emerald-700">⚖️ Plainte déposée</Badge>}
                <Badge variant="secondary" className="text-[10px]">{format(new Date(archive.archived_at), 'dd/MM/yyyy', { locale: fr })}</Badge>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => generateReport(archive)}>
                  <Download className="w-3 h-3 mr-1" /> Rapport
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setExpandedId(expandedId === archive.id ? null : archive.id)}>
                  <Eye className="w-3 h-3 mr-1" /> {expandedId === archive.id ? 'Masquer' : 'Détails'}
                </Button>
              </div>
            </div>

            {/* Summary */}
            <div className="flex gap-4 text-xs text-muted-foreground">
              <span>🎯 Victime : <strong className="text-foreground">{archive.victim_name || '-'}</strong></span>
              <span>🌐 {(archive.ip_addresses as string[] || []).length} IP(s)</span>
              <span>📱 {Array.isArray(archive.device_fingerprints) ? archive.device_fingerprints.length : 0} empreinte(s)</span>
              <span>📋 {Array.isArray(archive.connection_logs) ? archive.connection_logs.length : 0} log(s)</span>
              {archive.usurper_email && <span><Mail className="w-3 h-3 inline mr-1" />{archive.usurper_email}</span>}
            </div>

            {/* Expanded details */}
            {expandedId === archive.id && (
              <div className="space-y-3 pt-2 border-t border-border">
                {/* IPs */}
                <div>
                  <p className="text-xs font-semibold text-foreground mb-1">Adresses IP</p>
                  <div className="flex flex-wrap gap-1">
                    {(archive.ip_addresses || []).length > 0 ? (archive.ip_addresses as string[]).map((ip: string) => (
                      <Badge key={ip} variant="secondary" className="text-[10px] font-mono">{ip}</Badge>
                    )) : <span className="text-xs text-muted-foreground">Aucune</span>}
                  </div>
                </div>

                {/* Fingerprints */}
                <div>
                  <p className="text-xs font-semibold text-foreground mb-1">Empreintes numériques</p>
                  <div className="space-y-1 max-h-40 overflow-auto">
                    {(archive.device_fingerprints as any[] || []).map((f: any, i: number) => (
                      <div key={i} className="text-[10px] bg-secondary/30 rounded-lg p-2 font-mono">
                        Hash: {f.fingerprint_hash || '-'} · {f.screen_resolution || '-'} · {f.timezone || '-'} · {f.language || '-'}
                        <br />Agent: {(f.user_agent || '-').slice(0, 80)}...
                      </div>
                    ))}
                    {(archive.device_fingerprints as any[] || []).length === 0 && <span className="text-xs text-muted-foreground">Aucune</span>}
                  </div>
                </div>

                {/* Connection logs */}
                <div>
                  <p className="text-xs font-semibold text-foreground mb-1">Logs de connexion ({(archive.connection_logs as any[] || []).length})</p>
                  <div className="space-y-1 max-h-48 overflow-auto">
                    {(archive.connection_logs as any[] || []).slice(0, 15).map((l: any, i: number) => (
                      <div key={i} className="text-[10px] bg-secondary/30 rounded-lg px-2 py-1 flex items-center gap-2">
                        <Badge variant="secondary" className="text-[9px] shrink-0">{l.event_type || '-'}</Badge>
                        <span className="font-mono">{l.ip_address || '-'}</span>
                        <span className="text-muted-foreground ml-auto">{l.created_at ? format(new Date(l.created_at), 'dd/MM HH:mm', { locale: fr }) : '-'}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Profile snapshot */}
                {archive.profile_snapshot && (
                  <div>
                    <p className="text-xs font-semibold text-foreground mb-1">Snapshot du profil</p>
                    <div className="text-[10px] bg-secondary/30 rounded-lg p-2 space-y-0.5">
                      <p>Nom : {(archive.profile_snapshot as any).name || '-'}</p>
                      <p>Bio : {(archive.profile_snapshot as any).bio || '-'}</p>
                      <p>Ville : {(archive.profile_snapshot as any).city || '-'}</p>
                      <p>Créé le : {(archive.profile_snapshot as any).created_at ? format(new Date((archive.profile_snapshot as any).created_at), 'dd/MM/yyyy HH:mm', { locale: fr }) : '-'}</p>
                    </div>
                  </div>
                )}

                {/* Legal section */}
                <div className="bg-muted/30 rounded-lg p-3 space-y-2">
                  <p className="text-xs font-semibold text-foreground">⚖️ Suivi juridique</p>
                  {!archive.legal_complaint_filed ? (
                    <div className="flex gap-2">
                      <Input placeholder="Référence de la plainte" value={legalRef} onChange={e => setLegalRef(e.target.value)} className="flex-1 h-8 text-xs" />
                      <Button size="sm" className="h-8 text-xs" onClick={() => {
                        updateArchive.mutate({ id: archive.id, updates: { legal_complaint_filed: true, legal_complaint_date: new Date().toISOString(), legal_reference: legalRef || null } });
                        setLegalRef('');
                      }}>
                        Marquer plainte déposée
                      </Button>
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground space-y-1">
                      <p>✅ Plainte déposée le {archive.legal_complaint_date ? format(new Date(archive.legal_complaint_date), 'dd/MM/yyyy', { locale: fr }) : '-'}</p>
                      {archive.legal_reference && <p>Référence : <strong className="text-foreground">{archive.legal_reference}</strong></p>}
                    </div>
                  )}
                </div>

                {/* Admin notes */}
                {archive.admin_notes && (
                  <div className="text-xs text-muted-foreground">
                    <strong>Notes :</strong> {archive.admin_notes}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── ZEUS CONSOLE ───
function ZeusSection() {
  type ZMsg = { role: 'user' | 'assistant' | 'system'; content: string };
  const ZEUS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/zeus`;
  const QUICK_CMDS = [
    { label: '📊 Dashboard', prompt: 'Donne-moi un résumé exécutif complet de la plateforme avec KPIs, alertes et recommandations prioritaires' },
    { label: '🚨 Signalements', prompt: 'Analyse tous les signalements en attente, identifie les patterns récurrents et recommande des actions concrètes par priorité' },
    { label: '📈 Croissance', prompt: 'Analyse la croissance de la plateforme sur les 30 derniers jours : nouveaux inscrits, rétention, tendances, et compare avec la période précédente' },
    { label: '💰 Revenus', prompt: 'Analyse détaillée des revenus : MRR, commandes, tips, commissions. Identifie les leviers de monétisation sous-exploités' },
    { label: '🔒 Audit Sécurité', prompt: 'Lance un audit sécurité complet : profils suspects, trust scores faibles, tentatives de fraude, comptes bannis, vérifications en attente' },
    { label: '🛍️ Marketplace', prompt: 'Analyse la marketplace : produits, vendeurs, catégories populaires, prix moyens, et recommandations pour booster les ventes' },
    { label: '🎯 Engagement', prompt: 'Métriques d\'engagement de la semaine : likes, commentaires, lives, messages, stories. Quels contenus performent le mieux ?' },
    { label: '💡 Stratégie', prompt: 'En te basant sur toutes les données disponibles, propose un plan d\'action stratégique pour les 30 prochains jours avec objectifs mesurables' },
  ];
  const [messages, setMessages] = useState<ZMsg[]>([{ role: 'system', content: `⚡ **Zeus** — Assistant IA de Décision\n\nJe suis connecté à **toutes les données** de la plateforme en temps réel.\n\n📊 Stats • 🚨 Signalements • 📈 Tendances • 🔒 Sécurité • 💡 Recommandations\n\nPosez-moi n'importe quelle question sur votre plateforme.` }]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages]);

  const inferDomainAction = (text: string) => {
    const lower = text.toLowerCase();
    if (lower.startsWith('/status')) return { domain: '_status', action: 'status', extra: {} };
    // Explicit moderation request
    if ((lower.includes('modèr') || lower.includes('moder')) && (lower.includes('"') || lower.includes('«') || lower.includes(':'))) {
      const m = text.match(/[«"""](.+?)[»"""]|:\s*[«"""]?(.+)/); return { domain: 'moderation', action: 'moderate_message', extra: { messageBody: m?.[1] || m?.[2] || text } };
    }
    // Default: admin chat with full platform context
    return { domain: 'admin', action: 'chat', extra: {} };
  };

  const formatResult = (domain: string, action: string, data: any): string => {
    if (domain === 'moderation') return `### 🛡️ Modération\n| | |\n|---|---|\n|**Statut**|${data.safe ? '✅ Sûr' : '⚠️ Dangereux'}|\n|**Catégorie**|${data.category || 'safe'}|\n|**Raison**|${data.reason || 'Aucune'}|`;
    if (domain === 'post') return `### ✍️ Post Amélioré\n\n${data.improved_text || JSON.stringify(data)}${data.corrections?.length ? `\n\n**Corrections :** ${data.corrections.join(', ')}` : ''}`;
    if (domain === 'content') return `### 📝 Résultat\n\n${data.result || JSON.stringify(data)}`;
    return `### ⚡ Réponse\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  };

  // Keep conversation history for admin chat context
  const chatHistory = useRef<{role: string; content: string}[]>([]);

  const streamSSE = async (resp: Response, prefix = '') => {
    let content = ''; const reader = resp.body!.getReader(); const decoder = new TextDecoder(); let buf = '';
    while (true) { const { done, value } = await reader.read(); if (done) break; buf += decoder.decode(value, { stream: true }); let idx;
      while ((idx = buf.indexOf('\n')) !== -1) { let line = buf.slice(0, idx); buf = buf.slice(idx + 1); if (line.endsWith('\r')) line = line.slice(0, -1); if (!line.startsWith('data: ')) continue; const j = line.slice(6).trim(); if (j === '[DONE]') break;
        try { const c = JSON.parse(j).choices?.[0]?.delta?.content; if (c) { content += c; setMessages(p => { const last = p[p.length-1]; if (last?.role === 'assistant') return p.map((m,i) => i === p.length-1 ? {...m, content: prefix + content} : m); return [...p, {role:'assistant' as const, content: prefix + content}]; }); } } catch {} } }
    return content;
  };

  const send = useCallback(async () => {
    const text = input.trim(); if (!text || streaming) return;
    setInput(''); setMessages(p => [...p, { role: 'user', content: text }]); setStreaming(true);
    try {
      const { domain, action, extra } = inferDomainAction(text);
      if (domain === '_status') {
        setMessages(p => [...p, { role: 'assistant', content: `### ⚡ Zeus Status\n\n| Domaine | Actions |\n|---|---|\n|**content**|summarize, translate, correct, improve|\n|**post**|improve, formal, casual, shorter, longer|\n|**moderation**|moderate_message|\n|**ads**|chat, generate_ad, moderate_ad|\n|**seller**|generate_description, coach_chat|\n|**photo**|analyze_photo, compare_photos|\n|**agent**|chat agents|\n|**admin**|chat, stats, search_users|\n\n🟢 Opérationnel • 🧠 Gemini 3 Flash` }]);
        setStreaming(false); return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` };

      // Admin chat: streaming with conversation history
      if (domain === 'admin' && action === 'chat') {
        chatHistory.current.push({ role: 'user', content: text });
        const resp = await fetch(ZEUS_URL, { method: 'POST', headers, body: JSON.stringify({ domain, action, messages: chatHistory.current }) });
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || 'Erreur');
        const assistantContent = await streamSSE(resp);
        chatHistory.current.push({ role: 'assistant', content: assistantContent });
        setStreaming(false); return;
      }

      // Streaming responses (seller descriptions)
      if (domain === 'seller' && action === 'generate_description') {
        const resp = await fetch(ZEUS_URL, { method: 'POST', headers, body: JSON.stringify({ domain, action, ...extra }) });
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || 'Erreur');
        if (resp.headers.get('content-type')?.includes('event-stream')) { await streamSSE(resp, '### 📝 Description\n\n'); setStreaming(false); return; }
      }

      // Non-streaming
      const resp = await fetch(ZEUS_URL, { method: 'POST', headers, body: JSON.stringify({ domain, action, ...extra }) });
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `Erreur ${resp.status}`);
      const data = await resp.json();
      setMessages(p => [...p, { role: 'assistant', content: formatResult(domain, action, data) }]);
    } catch (e: any) { setMessages(p => [...p, { role: 'assistant', content: `### ❌ Erreur\n\n${e.message}` }]); }
    finally { setStreaming(false); }
  }, [input, streaming]);

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500/20 to-primary/20 border border-amber-500/30 flex items-center justify-center">
          <Zap className="w-5 h-5 text-amber-400" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-foreground">Zeus — Assistant de Décision</h2>
          <p className="text-[11px] text-muted-foreground">Accès total plateforme • Analyse en temps réel • Recommandations IA</p>
        </div>
        <Badge variant="outline" className="ml-auto text-[10px] border-amber-500/30 text-amber-400">LIVE</Badge>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 mb-3 pr-1">
        {messages.map((msg, i) => (
          <div key={i} className={cn('flex gap-2', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
            {msg.role !== 'user' && <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500/20 to-primary/20 border border-amber-500/30 flex items-center justify-center shrink-0 mt-1"><Zap className="w-3.5 h-3.5 text-amber-400" /></div>}
            <div className={cn('max-w-[85%] rounded-2xl px-3 py-2.5 text-sm', msg.role === 'user' ? 'bg-primary text-primary-foreground rounded-br-md' : 'bg-card border border-border rounded-bl-md')}>
              <div className="prose prose-sm max-w-none dark:prose-invert text-inherit"><ReactMarkdown>{msg.content}</ReactMarkdown></div>
            </div>
            {msg.role === 'user' && <div className="w-7 h-7 rounded-lg bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0 mt-1"><Users className="w-3.5 h-3.5 text-primary" /></div>}
          </div>
        ))}
        {streaming && messages[messages.length-1]?.role === 'user' && (
          <div className="flex gap-2"><div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500/20 to-primary/20 border border-amber-500/30 flex items-center justify-center shrink-0"><RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin" /></div>
            <div className="bg-card border border-border rounded-2xl rounded-bl-md px-3 py-2.5"><div className="flex gap-1"><span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" /><span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{animationDelay:'150ms'}} /><span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{animationDelay:'300ms'}} /></div></div></div>
        )}
      </div>

      <div className="flex gap-2 overflow-x-auto no-scrollbar pb-2">
        {QUICK_CMDS.map(c => (<button key={c.label} onClick={() => { setInput(c.prompt); inputRef.current?.focus(); }} className="px-3 py-1.5 rounded-full text-[11px] font-medium whitespace-nowrap bg-card border border-border hover:border-primary/40 text-muted-foreground hover:text-foreground transition-all">{c.label}</button>))}
      </div>

      <div className="flex gap-2 items-end mt-1">
        <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Commandez Zeus..." className="flex-1 min-h-[42px] max-h-[100px] resize-none text-sm rounded-xl border border-input bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring" rows={1} />
        <Button onClick={send} disabled={!input.trim() || streaming} className="h-[42px] w-[42px] shrink-0 bg-gradient-to-br from-amber-500 to-primary" size="icon">
          {streaming ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
        </Button>
      </div>
    </div>
  );
}

// ─── MAIN ADMIN PAGE ───
export default function Admin() {
  const [section, setSection] = useState<AdminSection>('dashboard');
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: isAdmin, isLoading } = useIsAdmin();

  useEffect(() => {
    if (!isLoading && !isAdmin) {
      navigate('/feed');
      toast({ title: 'Accès refusé', description: "Vous n'avez pas les droits administrateur.", variant: 'destructive' });
    }
  }, [isAdmin, isLoading, navigate]);

  if (isLoading) return <AppLayout><div className="flex items-center justify-center h-64 text-muted-foreground">Vérification des droits...</div></AppLayout>;
  if (!isAdmin) return null;

  const renderSection = () => {
    switch (section) {
      case 'dashboard': return <DashboardSection />;
      case 'users': return <UsersSection />;
      case 'posts': return <PostsSection />;
      case 'reports': return <ReportsSection />;
      case 'verifications': return <VerificationsSection />;
      case 'archives': return <ArchivesSection />;
      case 'stats': return <StatsSection />;
      case 'subscriptions': return <SubscriptionsSection />;
      case 'ai': return <AISection />;
      case 'zeus': return <ZeusSection />;
      case 'security': return <SecuritySection />;
      case 'settings': return <SettingsSection />;
    }
  };

  return (
    <AppLayout>
      <div className="flex min-h-[calc(100vh-4rem)]">
        {/* Sidebar */}
        <aside className="w-56 shrink-0 border-r border-border bg-card/50 p-3 hidden md:block">
          <div className="flex items-center gap-2 px-3 py-3 mb-2">
            <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
              <Shield className="w-4 h-4 text-primary" />
            </div>
            <span className="font-bold text-sm text-foreground">Admin</span>
          </div>
          <nav className="space-y-0.5">
            {NAV_ITEMS.map(item => (
              <button
                key={item.key}
                onClick={() => setSection(item.key)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-all',
                  section === item.key
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                )}
              >
                <item.icon className="w-4 h-4" />
                <span>{item.label}</span>
                {section === item.key && <ChevronRight className="w-3 h-3 ml-auto" />}
              </button>
            ))}
          </nav>
        </aside>

        {/* Mobile nav */}
        <div className="md:hidden w-full">
          <div className="overflow-x-auto border-b border-border px-2 py-2 flex gap-1 bg-card/50">
            {NAV_ITEMS.map(item => (
              <button
                key={item.key}
                onClick={() => setSection(item.key)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs whitespace-nowrap transition-all shrink-0',
                  section === item.key
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground'
                )}
              >
                <item.icon className="w-3 h-3" />
                {item.label}
              </button>
            ))}
          </div>
          <div className="p-4">{renderSection()}</div>
        </div>

        {/* Content */}
        <main className="flex-1 p-6 hidden md:block overflow-auto">
          {renderSection()}
        </main>
      </div>
    </AppLayout>
  );
}
