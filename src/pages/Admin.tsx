import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/hooks/use-toast';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { 
  Shield, Users, Ban, Activity, DollarSign, AlertTriangle, 
  Search, RefreshCw, Eye, UserX, Globe, Clock, TrendingUp 
} from 'lucide-react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { motion } from 'framer-motion';

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

function SecurityLogsTab() {
  const [search, setSearch] = useState('');
  const { data: logs, isLoading, refetch } = useQuery({
    queryKey: ['security-logs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('security_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
  });

  const filteredLogs = logs?.filter(l => 
    !search.trim() || 
    l.event_type?.toLowerCase().includes(search.toLowerCase()) ||
    l.ip_address?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Rechercher par type ou IP..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Button variant="outline" size="icon" onClick={() => refetch()}>
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>
      
      <div className="rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>Utilisateur</TableHead>
              <TableHead>Détails</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : !filteredLogs?.length ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Aucun log</TableCell></TableRow>
            ) : (
              filteredLogs.map(log => (
                <TableRow key={log.id}>
                  <TableCell>
                    <Badge variant={log.event_type?.includes('attack') || log.event_type?.includes('suspicious') ? 'destructive' : 'secondary'} className="text-[10px]">
                      {log.event_type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs font-mono">{log.ip_address || '-'}</TableCell>
                  <TableCell className="text-xs">{log.user_id?.slice(0, 8) || '-'}</TableCell>
                  <TableCell className="text-xs max-w-[200px] truncate">{JSON.stringify(log.details) || '-'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{format(new Date(log.created_at), 'dd/MM HH:mm', { locale: fr })}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function BannedIPsTab() {
  const queryClient = useQueryClient();
  const [newIp, setNewIp] = useState('');
  const [reason, setReason] = useState('');
  const { user } = useAuth();

  const { data: bannedIps, isLoading } = useQuery({
    queryKey: ['banned-ips'],
    queryFn: async () => {
      const { data, error } = await supabase.from('banned_ips').select('*').eq('is_active', true).order('banned_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const banIp = useMutation({
    mutationFn: async () => {
      if (!newIp.trim() || !user) throw new Error('IP requise');
      const { error } = await supabase.from('banned_ips').insert({ ip_address: newIp.trim(), reason: reason.trim() || null, banned_by: user.id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: '🚫 IP bannie', description: `${newIp} a été bannie.` });
      setNewIp(''); setReason('');
      queryClient.invalidateQueries({ queryKey: ['banned-ips'] });
    },
    onError: (e: any) => toast({ title: 'Erreur', description: e.message, variant: 'destructive' }),
  });

  const unbanIp = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('banned_ips').update({ is_active: false }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: 'IP débannie' });
      queryClient.invalidateQueries({ queryKey: ['banned-ips'] });
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><Globe className="w-4 h-4" /> Bannir une adresse IP</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <Input placeholder="Adresse IP (ex: 192.168.1.1)" value={newIp} onChange={e => setNewIp(e.target.value)} className="flex-1" />
            <Input placeholder="Raison (optionnel)" value={reason} onChange={e => setReason(e.target.value)} className="flex-1" />
            <Button onClick={() => banIp.mutate()} disabled={banIp.isPending || !newIp.trim()}>
              <Ban className="w-4 h-4 mr-1" /> Bannir
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>IP</TableHead>
              <TableHead>Raison</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : !bannedIps?.length ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Aucune IP bannie</TableCell></TableRow>
            ) : (
              bannedIps.map(ip => (
                <TableRow key={ip.id}>
                  <TableCell className="font-mono text-sm">{ip.ip_address}</TableCell>
                  <TableCell className="text-xs">{ip.reason || '-'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{format(new Date(ip.banned_at), 'dd/MM/yyyy HH:mm', { locale: fr })}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => unbanIp.mutate(ip.id)}>
                      Débannir
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function BannedUsersTab() {
  const queryClient = useQueryClient();
  const [searchUser, setSearchUser] = useState('');
  const [banReason, setBanReason] = useState('');
  const { user } = useAuth();

  const { data: bannedUsers, isLoading } = useQuery({
    queryKey: ['banned-users'],
    queryFn: async () => {
      const { data, error } = await supabase.from('banned_users').select('*').eq('is_active', true).order('banned_at', { ascending: false });
      if (error) throw error;
      // Fetch profiles for display
      if (!data?.length) return [];
      const userIds = data.map(b => b.user_id);
      const { data: profiles } = await supabase.from('profiles').select('user_id, name, avatar_url').in('user_id', userIds);
      return data.map(b => ({
        ...b,
        profile: profiles?.find(p => p.user_id === b.user_id),
      }));
    },
  });

  const { data: searchResults } = useQuery({
    queryKey: ['admin-search-users', searchUser],
    queryFn: async () => {
      if (!searchUser.trim()) return [];
      const { data } = await supabase.from('profiles').select('user_id, name, avatar_url').ilike('name', `%${searchUser}%`).limit(5);
      return data || [];
    },
    enabled: searchUser.trim().length > 1,
  });

  const banUser = useMutation({
    mutationFn: async (userId: string) => {
      if (!user) throw new Error('Non authentifié');
      const { error } = await supabase.from('banned_users').insert({ user_id: userId, reason: banReason.trim() || null, banned_by: user.id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: '🚫 Utilisateur banni' });
      setSearchUser(''); setBanReason('');
      queryClient.invalidateQueries({ queryKey: ['banned-users'] });
    },
    onError: (e: any) => toast({ title: 'Erreur', description: e.message, variant: 'destructive' }),
  });

  const unbanUser = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('banned_users').update({ is_active: false }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: 'Utilisateur débanni' });
      queryClient.invalidateQueries({ queryKey: ['banned-users'] });
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><UserX className="w-4 h-4" /> Bannir un utilisateur</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <Input placeholder="Rechercher un utilisateur..." value={searchUser} onChange={e => setSearchUser(e.target.value)} className="flex-1" />
            <Input placeholder="Raison" value={banReason} onChange={e => setBanReason(e.target.value)} className="flex-1" />
          </div>
          {searchResults && searchResults.length > 0 && (
            <div className="rounded-lg border border-border p-1 space-y-1">
              {searchResults.map(u => (
                <div key={u.user_id} className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-secondary/40">
                  <span className="text-sm font-medium">{u.name}</span>
                  <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => banUser.mutate(u.user_id)} disabled={banUser.isPending}>
                    <Ban className="w-3 h-3 mr-1" /> Bannir
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Utilisateur</TableHead>
              <TableHead>Raison</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : !bannedUsers?.length ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Aucun utilisateur banni</TableCell></TableRow>
            ) : (
              bannedUsers.map(b => (
                <TableRow key={b.id}>
                  <TableCell className="text-sm font-medium">{(b as any).profile?.name || b.user_id.slice(0, 8)}</TableCell>
                  <TableCell className="text-xs">{b.reason || '-'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{format(new Date(b.banned_at), 'dd/MM/yyyy HH:mm', { locale: fr })}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => unbanUser.mutate(b.id)}>
                      Débannir
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function StatsOverviewTab() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ['admin-stats'],
    queryFn: async () => {
      const [usersRes, postsRes, ordersRes, agentUsageRes, activeUsersRes] = await Promise.all([
        supabase.from('profiles').select('id', { count: 'exact', head: true }),
        supabase.from('posts').select('id', { count: 'exact', head: true }),
        supabase.from('orders').select('id, total, status, created_at'),
        supabase.from('ai_agent_usage').select('id, message_count').gte('usage_date', new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).gte('updated_at', new Date(Date.now() - 7 * 86400000).toISOString()),
      ]);

      const orders = ordersRes.data || [];
      const totalRevenue = orders.filter(o => o.status !== 'cancelled' && o.status !== 'refunded').reduce((sum, o) => sum + (o.total || 0), 0);
      const monthlyOrders = orders.filter(o => {
        const d = new Date(o.created_at);
        const now = new Date();
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      });
      const monthlyRevenue = monthlyOrders.filter(o => o.status !== 'cancelled' && o.status !== 'refunded').reduce((sum, o) => sum + (o.total || 0), 0);

      const agentMessages = (agentUsageRes.data || []).reduce((sum, u) => sum + (u.message_count || 0), 0);

      return {
        totalUsers: usersRes.count || 0,
        totalPosts: postsRes.count || 0,
        totalRevenue,
        monthlyRevenue,
        totalOrders: orders.length,
        monthlyOrders: monthlyOrders.length,
        activeUsers7d: activeUsersRes.count || 0,
        agentMessages7d: agentMessages,
      };
    },
  });

  if (isLoading) return <div className="text-center py-8 text-muted-foreground">Chargement des statistiques...</div>;

  const cards = [
    { label: 'Utilisateurs total', value: stats?.totalUsers || 0, icon: Users, color: 'text-blue-600 bg-blue-500/10' },
    { label: 'Actifs (7j)', value: stats?.activeUsers7d || 0, icon: Activity, color: 'text-emerald-600 bg-emerald-500/10' },
    { label: 'Publications', value: stats?.totalPosts || 0, icon: Eye, color: 'text-purple-600 bg-purple-500/10' },
    { label: 'Revenus total', value: `${(stats?.totalRevenue || 0).toFixed(2)}€`, icon: DollarSign, color: 'text-amber-600 bg-amber-500/10' },
    { label: 'Revenus ce mois', value: `${(stats?.monthlyRevenue || 0).toFixed(2)}€`, icon: TrendingUp, color: 'text-emerald-600 bg-emerald-500/10' },
    { label: 'Commandes total', value: stats?.totalOrders || 0, icon: DollarSign, color: 'text-blue-600 bg-blue-500/10' },
    { label: 'Commandes ce mois', value: stats?.monthlyOrders || 0, icon: Clock, color: 'text-purple-600 bg-purple-500/10' },
    { label: 'Messages IA (7j)', value: stats?.agentMessages7d || 0, icon: Activity, color: 'text-amber-600 bg-amber-500/10' },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((card, i) => (
        <motion.div
          key={card.label}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05 }}
        >
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
  );
}

function AttackProtectionTab() {
  const { data: suspiciousActivity, isLoading } = useQuery({
    queryKey: ['suspicious-activity'],
    queryFn: async () => {
      // Check device fingerprints for multi-accounts
      const { data: multiAccounts } = await supabase
        .from('device_fingerprints')
        .select('fingerprint_hash, ip_address, user_id, last_seen_at')
        .order('last_seen_at', { ascending: false })
        .limit(50);

      // Check rate limits for abuse
      const { data: rateLimited } = await supabase
        .from('rate_limits')
        .select('*')
        .eq('is_blocked', true)
        .order('created_at', { ascending: false })
        .limit(20);

      // Check flagged trust scores
      const { data: flagged } = await supabase
        .from('trust_scores')
        .select('user_id, trust_score, is_flagged, flag_reason, reports_received, reports_confirmed')
        .eq('is_flagged', true)
        .limit(20);

      // Get profiles for flagged users
      const flaggedIds = flagged?.map(f => f.user_id) || [];
      const { data: flaggedProfiles } = flaggedIds.length > 0
        ? await supabase.from('profiles').select('user_id, name').in('user_id', flaggedIds)
        : { data: [] };

      // Find duplicate IPs
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
        rateLimited: rateLimited || [],
        flaggedUsers: (flagged || []).map(f => ({
          ...f,
          name: flaggedProfiles?.find(p => p.user_id === f.user_id)?.name || f.user_id.slice(0, 8),
        })),
      };
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" /> IPs suspectes (multi-comptes)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? <p className="text-sm text-muted-foreground">Analyse en cours...</p> : (
            suspiciousActivity?.suspiciousIps.length === 0 ? (
              <p className="text-sm text-emerald-600">✅ Aucune IP suspecte détectée</p>
            ) : (
              <div className="space-y-2">
                {suspiciousActivity?.suspiciousIps.map(([ip, users]) => (
                  <div key={ip} className="flex items-center justify-between p-2 rounded-lg bg-destructive/5 border border-destructive/20">
                    <div>
                      <span className="font-mono text-sm">{ip}</span>
                      <span className="text-xs text-muted-foreground ml-2">{users.length} comptes</span>
                    </div>
                    <Badge variant="destructive" className="text-[10px]">Suspect</Badge>
                  </div>
                ))}
              </div>
            )
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="w-4 h-4 text-red-500" /> Utilisateurs signalés
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? <p className="text-sm text-muted-foreground">Chargement...</p> : (
            suspiciousActivity?.flaggedUsers.length === 0 ? (
              <p className="text-sm text-emerald-600">✅ Aucun utilisateur signalé</p>
            ) : (
              <div className="space-y-2">
                {suspiciousActivity?.flaggedUsers.map(u => (
                  <div key={u.user_id} className="flex items-center justify-between p-2 rounded-lg bg-amber-500/5 border border-amber-500/20">
                    <div>
                      <span className="text-sm font-medium">{u.name}</span>
                      <span className="text-xs text-muted-foreground ml-2">Score: {u.trust_score}/100</span>
                      <span className="text-xs text-destructive ml-2">{u.flag_reason}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Badge variant="secondary" className="text-[10px]">{u.reports_received} signalement{u.reports_received > 1 ? 's' : ''}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Ban className="w-4 h-4 text-red-500" /> Utilisateurs bloqués (rate-limit)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? <p className="text-sm text-muted-foreground">Chargement...</p> : (
            suspiciousActivity?.rateLimited.length === 0 ? (
              <p className="text-sm text-emerald-600">✅ Aucun blocage actif</p>
            ) : (
              <div className="space-y-2">
                {suspiciousActivity?.rateLimited.map(r => (
                  <div key={r.id} className="flex items-center justify-between p-2 rounded-lg bg-red-500/5 border border-red-500/20">
                    <div>
                      <span className="text-sm font-mono">{r.user_id.slice(0, 8)}...</span>
                      <span className="text-xs text-muted-foreground ml-2">{r.action_type}: {r.action_count} actions</span>
                    </div>
                    <Badge variant="destructive" className="text-[10px]">Bloqué</Badge>
                  </div>
                ))}
              </div>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function Admin() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: isAdmin, isLoading } = useIsAdmin();

  useEffect(() => {
    if (!isLoading && !isAdmin) {
      navigate('/feed');
      toast({ title: 'Accès refusé', description: 'Vous n\'avez pas les droits administrateur.', variant: 'destructive' });
    }
  }, [isAdmin, isLoading, navigate]);

  if (isLoading) return <AppLayout><div className="flex items-center justify-center h-64 text-muted-foreground">Vérification des droits...</div></AppLayout>;
  if (!isAdmin) return null;

  return (
    <AppLayout>
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
            <Shield className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Panneau d'administration</h1>
            <p className="text-xs text-muted-foreground">Contrôle, sécurité et analytics ForSure</p>
          </div>
        </div>

        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList className="grid grid-cols-5 w-full">
            <TabsTrigger value="overview" className="text-xs gap-1"><TrendingUp className="w-3 h-3" /> Vue globale</TabsTrigger>
            <TabsTrigger value="logs" className="text-xs gap-1"><Activity className="w-3 h-3" /> Logs</TabsTrigger>
            <TabsTrigger value="protection" className="text-xs gap-1"><Shield className="w-3 h-3" /> Protection</TabsTrigger>
            <TabsTrigger value="ban-ip" className="text-xs gap-1"><Globe className="w-3 h-3" /> IPs bannies</TabsTrigger>
            <TabsTrigger value="ban-users" className="text-xs gap-1"><UserX className="w-3 h-3" /> Utilisateurs</TabsTrigger>
          </TabsList>

          <TabsContent value="overview"><StatsOverviewTab /></TabsContent>
          <TabsContent value="logs"><SecurityLogsTab /></TabsContent>
          <TabsContent value="protection"><AttackProtectionTab /></TabsContent>
          <TabsContent value="ban-ip"><BannedIPsTab /></TabsContent>
          <TabsContent value="ban-users"><BannedUsersTab /></TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
