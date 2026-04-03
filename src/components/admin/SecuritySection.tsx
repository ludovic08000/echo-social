import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Globe, Lock, UserX, AlertTriangle, Ban, Mail } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

export function SecuritySection() {
  const [newIp, setNewIp] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [reason, setReason] = useState('');
  const [emailReason, setEmailReason] = useState('');
  const queryClient = useQueryClient();
  const { user } = useAuth();

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
      const { error } = await supabase.from('banned_emails').insert({ email: newEmail.trim().toLowerCase(), reason: emailReason.trim() || 'Banni par admin', banned_by: user.id });
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

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Lock className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-bold text-foreground">Sécurité & Anti-abus</h2>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'IPs bannies', value: bannedIps?.length || 0, icon: Globe, color: 'text-red-600 bg-red-500/10' },
          { label: 'Emails bannis', value: bannedEmails?.length || 0, icon: Mail, color: 'text-orange-600 bg-orange-500/10' },
          { label: 'Comptes bannis', value: bannedUsers?.length || 0, icon: UserX, color: 'text-destructive bg-destructive/10' },
          { label: 'IPs suspectes', value: suspiciousActivity?.suspiciousIps.length || 0, icon: AlertTriangle, color: 'text-amber-600 bg-amber-500/10' },
        ].map((card, i) => (
          <motion.div key={card.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center shrink-0', card.color)}>
                    <card.icon className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-lg font-bold text-foreground">{card.value}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{card.label}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Ban IP */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><Globe className="w-4 h-4" /> Bannir une IP</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <Input placeholder="Adresse IP" value={newIp} onChange={e => setNewIp(e.target.value)} className="flex-1" />
            <Input placeholder="Raison (optionnel)" value={reason} onChange={e => setReason(e.target.value)} className="flex-1" />
            <Button onClick={() => banIp.mutate()} disabled={!newIp.trim()} className="shrink-0">
              <Ban className="w-4 h-4 mr-1" /> <span className="truncate">Bannir</span>
            </Button>
          </div>
          {bannedIps && bannedIps.length > 0 && (
            <div className="space-y-1">{bannedIps.map(ip => (
              <div key={ip.id} className="flex items-center justify-between p-2.5 rounded-lg bg-accent text-sm gap-2">
                <span className="font-mono text-xs truncate">{ip.ip_address}</span>
                <Button size="sm" variant="ghost" className="h-7 text-xs shrink-0" onClick={() => unbanIp.mutate(ip.id)}>Débannir</Button>
              </div>
            ))}</div>
          )}
        </CardContent>
      </Card>

      {/* Ban Email */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><Mail className="w-4 h-4" /> Bannir un email</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <Input placeholder="Email" value={newEmail} onChange={e => setNewEmail(e.target.value)} className="flex-1" />
            <Input placeholder="Raison" value={emailReason} onChange={e => setEmailReason(e.target.value)} className="flex-1" />
            <Button onClick={() => banEmail.mutate()} disabled={!newEmail.trim()} className="shrink-0">
              <Ban className="w-4 h-4 mr-1" /> <span className="truncate">Bannir</span>
            </Button>
          </div>
          {bannedEmails && bannedEmails.length > 0 && (
            <div className="space-y-1">{bannedEmails.map(em => (
              <div key={em.id} className="flex items-center justify-between p-2.5 rounded-lg bg-accent text-sm gap-2">
                <span className="text-xs truncate">{em.email}</span>
                <Button size="sm" variant="ghost" className="h-7 text-xs shrink-0" onClick={() => unbanEmail.mutate(em.id)}>Débannir</Button>
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
              <div key={b.id} className="flex items-center justify-between p-2.5 rounded-lg bg-accent text-sm gap-2">
                <span className="truncate">{b.profile?.name || b.user_id.slice(0, 8)} — {b.reason}</span>
                <Button size="sm" variant="ghost" className="h-7 text-xs shrink-0" onClick={() => unbanUser.mutate(b.id)}>Débannir</Button>
              </div>
            ))}</div>
          </CardContent>
        </Card>
      )}

      {/* Flagged Users */}
      {suspiciousActivity?.flaggedUsers && suspiciousActivity.flaggedUsers.length > 0 && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-500" /> Utilisateurs signalés</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1">{suspiciousActivity.flaggedUsers.map((u: any) => (
              <div key={u.user_id} className="flex items-center justify-between p-2.5 rounded-lg bg-accent text-sm gap-2">
                <div className="min-w-0">
                  <span className="font-medium truncate block">{u.name}</span>
                  <span className="text-xs text-muted-foreground">Score: {u.trust_score} · {u.reports_received} signalements · {u.flag_reason}</span>
                </div>
              </div>
            ))}</div>
          </CardContent>
        </Card>
      )}

      {/* Suspicious IPs */}
      {suspiciousActivity?.suspiciousIps && suspiciousActivity.suspiciousIps.length > 0 && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><Globe className="w-4 h-4 text-amber-500" /> IPs multi-comptes</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1">{suspiciousActivity.suspiciousIps.map(([ip, userIds]) => (
              <div key={ip} className="flex items-center justify-between p-2.5 rounded-lg bg-accent text-sm gap-2">
                <span className="font-mono text-xs truncate">{ip}</span>
                <Badge variant="destructive" className="text-[10px] shrink-0">{userIds.length} comptes</Badge>
              </div>
            ))}</div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
