import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Users, Ban, RefreshCw, Cpu, Archive } from 'lucide-react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { cn } from '@/lib/utils';

export function VerificationsSection() {
  const queryClient = useQueryClient();
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [analysisResults, setAnalysisResults] = useState<Record<string, any>>({});

  const { data: verifications, isLoading } = useQuery({
    queryKey: ['admin-verifications'],
    queryFn: async () => {
      const { data, error } = await supabase.from('identity_verifications').select('*').order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      const userIds = [...new Set([...(data?.map(v => v.reported_user_id) || []), ...(data?.map(v => v.reporter_id) || [])])];
      const { data: profiles } = userIds.length > 0 ? await supabase.from('profiles').select('user_id, name, avatar_url').in('user_id', userIds) : { data: [] };
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
    onSuccess: () => { toast({ title: 'Vérification mise à jour' }); queryClient.invalidateQueries({ queryKey: ['admin-verifications'] }); },
  });

  const deleteAccount = useMutation({
    mutationFn: async ({ id, userId }: { id: string; userId: string }) => {
      await supabase.from('identity_verifications').update({ status: 'deleted', auto_deleted: true, updated_at: new Date().toISOString() }).eq('id', id);
      const { data: { user } } = await supabase.auth.getUser();
      if (user) await supabase.from('banned_users').insert({ user_id: userId, reason: 'Faux compte non vérifié', banned_by: user.id });
    },
    onSuccess: () => { toast({ title: '🚫 Compte supprimé/banni' }); queryClient.invalidateQueries({ queryKey: ['admin-verifications'] }); },
  });

  const archiveUsurper = async (v: any) => {
    try {
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      if (!currentUser) return;
      const { data: profile } = await supabase.from('profiles').select('id, user_id, name, avatar_url, bio, city, created_at').eq('user_id', v.reported_user_id).maybeSingle();
      const { data: fingerprints } = await supabase.from('device_fingerprints').select('*').eq('user_id', v.reported_user_id);
      const ips = [...new Set((fingerprints || []).map((f: any) => f.ip_address).filter(Boolean))] as string[];
      const { data: connLogs } = await supabase.from('security_logs').select('*').or(`details->>user_id.eq.${v.reported_user_id},ip_address.in.(${ips.join(',')})`).order('created_at', { ascending: false }).limit(50);
      const caseNumber = `USR-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const { error } = await supabase.from('identity_theft_archives').insert({
        usurper_user_id: v.reported_user_id, usurper_name: v.reportedName || profile?.name, usurper_email: v.reported_email || null,
        usurper_avatar_url: v.reportedAvatar || profile?.avatar_url, usurper_bio: profile?.bio, victim_user_id: v.reporter_id, victim_name: v.reporterName,
        ip_addresses: ips, device_fingerprints: fingerprints || [], connection_logs: connLogs || [], profile_snapshot: profile || {},
        archived_by: currentUser.id, case_number: caseNumber, admin_notes: `Archivé depuis vérification ID #${v.id}`,
      });
      if (error) throw error;
      await supabase.from('banned_users').insert({ user_id: v.reported_user_id, reason: `Usurpation d'identité - Dossier ${caseNumber}`, banned_by: currentUser.id });
      for (const ip of ips) { try { await supabase.from('banned_ips').insert({ ip_address: ip, reason: `Usurpation - ${caseNumber}`, banned_by: currentUser.id }); } catch {} }
      await supabase.from('identity_verifications').update({ status: 'deleted', auto_deleted: true, updated_at: new Date().toISOString() }).eq('id', v.id);
      toast({ title: '📁 Profil archivé', description: `Dossier ${caseNumber} créé.` });
      queryClient.invalidateQueries({ queryKey: ['admin-verifications'] });
    } catch (e: any) { toast({ title: 'Erreur', description: e.message, variant: 'destructive' }); }
  };

  const analyzePhoto = async (userId: string, avatarUrl: string) => {
    if (!avatarUrl) { toast({ title: 'Pas de photo', variant: 'destructive' }); return; }
    setAnalyzing(userId);
    try {
      const [analyzeRes, compareRes] = await Promise.all([
        supabase.functions.invoke('zeus', { body: { domain: 'photo', action: 'analyze_photo', imageUrl: avatarUrl } }),
        supabase.functions.invoke('zeus', { body: { domain: 'photo', action: 'compare_photos' } }),
      ]);
      setAnalysisResults(prev => ({ ...prev, [userId]: { analysis: analyzeRes.data?.analysis, comparison: compareRes.data } }));
    } catch (e: any) { toast({ title: 'Erreur analyse', description: e.message, variant: 'destructive' }); }
    finally { setAnalyzing(null); }
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
        <h2 className="text-lg font-bold text-foreground">Vérifications d'identité</h2>
        <Badge variant="secondary">{verifications?.filter(v => v.status === 'pending_verification').length || 0} en attente</Badge>
      </div>

      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4 flex items-start gap-3">
          <Cpu className="w-5 h-5 text-primary mt-0.5 shrink-0" />
          <div className="text-xs space-y-1">
            <p className="font-semibold text-foreground">Protection IA active</p>
            <p className="text-muted-foreground">L'IA analyse les photos de profil pour détecter les images volées, photos stock, générations IA et doublons.</p>
          </div>
        </CardContent>
      </Card>

      {verifications?.filter(v => v.status === 'pending_verification' && isExpired(v.deadline_at)).map(v => (
        <Card key={`expired-${v.id}`} className="border-destructive/30 bg-destructive/5">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-destructive">⏰ Délai expiré — {v.reportedName}</p>
                <p className="text-xs text-muted-foreground">Signalé par {v.reporterName}</p>
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
              <TableHead>Photo</TableHead><TableHead>Compte signalé</TableHead><TableHead>Signalé par</TableHead>
              <TableHead>Statut</TableHead><TableHead>Deadline</TableHead><TableHead>Document</TableHead>
              <TableHead>Analyse IA</TableHead><TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : !verifications?.length ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Aucune vérification</TableCell></TableRow>
            ) : verifications.map(v => {
              const result = analysisResults[v.reported_user_id];
              return (
                <TableRow key={v.id}>
                  <TableCell>
                    {v.reportedAvatar ? <img src={v.reportedAvatar} alt="" className="w-10 h-10 rounded-full object-cover" /> :
                      <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center"><Users className="w-4 h-4 text-muted-foreground" /></div>}
                  </TableCell>
                  <TableCell className="font-medium text-sm">{v.reportedName}</TableCell>
                  <TableCell className="text-sm">{v.reporterName}</TableCell>
                  <TableCell>{getStatusBadge(v.status)}</TableCell>
                  <TableCell className={cn('text-xs', isExpired(v.deadline_at) && v.status === 'pending_verification' ? 'text-destructive font-semibold' : 'text-muted-foreground')}>
                    {format(new Date(v.deadline_at), 'dd/MM HH:mm', { locale: fr })}
                  </TableCell>
                  <TableCell>
                    {v.id_document_url ? (
                      <Button size="sm" variant="link" className="text-xs p-0 h-auto" onClick={async () => {
                        const { data } = await supabase.storage.from('id-documents').createSignedUrl(v.id_document_url, 300);
                        if (data?.signedUrl) window.open(data.signedUrl, '_blank');
                      }}>Voir</Button>
                    ) : <span className="text-xs text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell>
                    {result ? (
                      <div className="space-y-1">
                        {result.analysis && getRiskBadge(result.analysis.risk_score || 0)}
                        {result.comparison?.has_duplicates && <Badge variant="destructive" className="text-[10px]">⚠️ Doublon</Badge>}
                      </div>
                    ) : (
                      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={analyzing === v.reported_user_id} onClick={() => analyzePhoto(v.reported_user_id, v.reportedAvatar)}>
                        {analyzing === v.reported_user_id ? <><RefreshCw className="w-3 h-3 mr-1 animate-spin" /> Analyse...</> : <>🔍 Scanner</>}
                      </Button>
                    )}
                  </TableCell>
                  <TableCell>
                    {v.status !== 'verified' && v.status !== 'deleted' && (
                      <div className="flex gap-1 flex-wrap">
                        {v.status === 'document_submitted' && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => updateVerification.mutate({ id: v.id, status: 'verified' })}>✅ Valider</Button>}
                        <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => deleteAccount.mutate({ id: v.id, userId: v.reported_user_id })}>Supprimer</Button>
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
    </div>
  );
}
