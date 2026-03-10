import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Globe, Lock, UserX, AlertTriangle, Ban, Search, RefreshCw, Mail } from 'lucide-react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

export function SecuritySection() {
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
      const { data: multiAccounts } = await supabase.from('device_fingerprints').select('fingerprint_hash, ip_address, user_id, last_seen_at').order('last_seen_at', { ascending: false }).limit(50);
      const { data: flagged } = await supabase.from('trust_scores').select('user_id, trust_score, is_flagged, flag_reason, reports_received').eq('is_flagged', true).limit(20);
      const flaggedIds = flagged?.map(f => f.user_id) || [];
      const { data: flaggedProfiles } = flaggedIds.length > 0 ? await supabase.from('profiles').select('user_id, name').in('user_id', flaggedIds) : { data: [] };
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
        flaggedUsers: (flagged || []).map(f => ({ ...f, name: flaggedProfiles?.find(p => p.user_id === f.user_id)?.name || f.user_id.slice(0, 8) })),
      };
    },
  });

  const banIp = useMutation({
    mutationFn: async () => {
      if (!newIp.trim() || !user) throw new Error('IP requise');
      const { error } = await supabase.from('banned_ips').insert({ ip_address: newIp.trim(), reason: reason.trim() || null, banned_by: user.id });
      if (error) throw error;
    },
    onSuccess: () => { toast({ title: '🚫 IP bannie' }); setNewIp(''); setReason(''); queryClient.invalidateQueries({ queryKey: ['banned-ips'] }); },
    onError: (e: any) => toast({ title: 'Erreur', description: e.message, variant: 'destructive' }),
  });

  const banEmail = useMutation({
    mutationFn: async () => {
      if (!newEmail.trim() || !user) throw new Error('Email requis');
      const { error } = await supabase.from('banned_emails').insert({ email: newEmail.trim().toLowerCase(), reason: emailReason.trim() || 'Usurpation d\'identité', banned_by: user.id });
      if (error) throw error;
    },
    onSuccess: () => { toast({ title: '🚫 Email banni' }); setNewEmail(''); setEmailReason(''); queryClient.invalidateQueries({ queryKey: ['banned-emails'] }); },
    onError: (e: any) => toast({ title: 'Erreur', description: e.message, variant: 'destructive' }),
  });

  const unbanIp = useMutation({
    mutationFn: async (id: string) => { const { error } = await supabase.from('banned_ips').update({ is_active: false }).eq('id', id); if (error) throw error; },
    onSuccess: () => { toast({ title: 'IP débannie' }); queryClient.invalidateQueries({ queryKey: ['banned-ips'] }); },
  });

  const unbanEmail = useMutation({
    mutationFn: async (id: string) => { const { error } = await supabase.from('banned_emails').update({ is_active: false }).eq('id', id); if (error) throw error; },
    onSuccess: () => { toast({ title: 'Email débanni' }); queryClient.invalidateQueries({ queryKey: ['banned-emails'] }); },
  });

  const unbanUser = useMutation({
    mutationFn: async (id: string) => { const { error } = await supabase.from('banned_users').update({ is_active: false }).eq('id', id); if (error) throw error; },
    onSuccess: () => { toast({ title: 'Utilisateur débanni' }); queryClient.invalidateQueries({ queryKey: ['banned-users-security'] }); },
  });

  const filteredLogs = logs?.filter(l => !search.trim() || l.event_type?.toLowerCase().includes(search.toLowerCase()) || l.ip_address?.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-foreground">Sécurité & Anti-Usurpation</h2>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'IPs bannies', value: bannedIps?.length || 0, icon: Globe, color: 'text-red-600 bg-red-500/10' },
          { label: 'Emails bannis', value: bannedEmails?.length || 0, icon: Lock, color: 'text-orange-600 bg-orange-500/10' },
          { label: 'Comptes bannis', value: bannedUsers?.length || 0, icon: UserX, color: 'text-destructive bg-destructive/10' },
          { label: 'IPs suspectes', value: suspiciousActivity?.suspiciousIps.length || 0, icon: AlertTriangle, color: 'text-amber-600 bg-amber-500/10' },
        ].map((card, i) => (
          <motion.div key={card.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <Card><CardContent className="p-4"><div className="flex items-center gap-3"><div className={cn('w-10 h-10 rounded-xl flex items-center justify-center', card.color)}><card.icon className="w-5 h-5" /></div><div><p className="text-lg font-bold text-foreground">{card.value}</p><p className="text-[10px] text-muted-foreground">{card.label}</p></div></div></CardContent></Card>
          </motion.div>
        ))}
      </div>

      {/* Ban IP */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><Globe className="w-4 h-4" /> Bannir une IP</CardTitle></CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input placeholder="Adresse IP" value={newIp} onChange={e => setNewIp(e.target.value)} className="flex-1" />
            <Input placeholder="Raison (optionnel)" value={reason} onChange={e => setReason(e.target.value)} className="flex-1" />
            <Button onClick={() => banIp.mutate()} disabled={!newIp.trim()}><Ban className="w-4 h-4 mr-1" /> Bannir</Button>
          </div>
          {bannedIps && bannedIps.length > 0 && (
            <div className="mt-3 space-y-1">{bannedIps.map(ip => (
              <div key={ip.id} className="flex items-center justify-between p-2 rounded-lg bg-secondary/30 text-sm">
                <span className="font-mono">{ip.ip_address}</span>
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => unbanIp.mutate(ip.id)}>Débannir</Button>
              </div>
            ))}</div>
          )}
        </CardContent>
      </Card>

      {/* Ban Email */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><Mail className="w-4 h-4" /> Bannir un email</CardTitle></CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input placeholder="Email" value={newEmail} onChange={e => setNewEmail(e.target.value)} className="flex-1" />
            <Input placeholder="Raison" value={emailReason} onChange={e => setEmailReason(e.target.value)} className="flex-1" />
            <Button onClick={() => banEmail.mutate()} disabled={!newEmail.trim()}><Ban className="w-4 h-4 mr-1" /> Bannir</Button>
          </div>
          {bannedEmails && bannedEmails.length > 0 && (
            <div className="mt-3 space-y-1">{bannedEmails.map(em => (
              <div key={em.id} className="flex items-center justify-between p-2 rounded-lg bg-secondary/30 text-sm">
                <span>{em.email}</span>
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => unbanEmail.mutate(em.id)}>Débannir</Button>
              </div>
            ))}</div>
          )}
        </CardContent>
      </Card>

      {/* Banned Users */}
      {bannedUsers && bannedUsers.length > 0 && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><UserX className="w-4 h-4" /> Comptes bannis</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1">{bannedUsers.map((b: any) => (
              <div key={b.id} className="flex items-center justify-between p-2 rounded-lg bg-secondary/30 text-sm">
                <span>{b.profile?.name || b.user_id.slice(0, 8)} — {b.reason}</span>
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => unbanUser.mutate(b.id)}>Débannir</Button>
              </div>
            ))}</div>
          </CardContent>
        </Card>
      )}

      {/* Security Logs */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Logs de sécurité</CardTitle>
            <div className="flex gap-2">
              <div className="relative"><Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" /><Input placeholder="Filtrer..." value={search} onChange={e => setSearch(e.target.value)} className="pl-7 h-8 w-48 text-xs" /></div>
              <Button size="sm" variant="outline" onClick={() => refetchLogs()} className="h-8"><RefreshCw className="w-3.5 h-3.5" /></Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader><TableRow><TableHead>Type</TableHead><TableHead>IP</TableHead><TableHead>Détails</TableHead><TableHead>Date</TableHead></TableRow></TableHeader>
              <TableBody>
                {logsLoading ? (
                  <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Chargement...</TableCell></TableRow>
                ) : !filteredLogs?.length ? (
                  <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Aucun log</TableCell></TableRow>
                ) : filteredLogs.slice(0, 30).map((log: any) => (
                  <TableRow key={log.id}>
                    <TableCell><Badge variant={log.event_type?.includes('attack') || log.event_type?.includes('suspicious') ? 'destructive' : 'secondary'} className="text-[10px]">{log.event_type}</Badge></TableCell>
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
