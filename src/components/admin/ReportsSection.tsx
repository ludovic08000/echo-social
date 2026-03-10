import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

export function ReportsSection() {
  const queryClient = useQueryClient();

  const { data: reports, isLoading } = useQuery({
    queryKey: ['admin-reports'],
    queryFn: async () => {
      const { data, error } = await supabase.from('abuse_reports').select('*').order('created_at', { ascending: false }).limit(50);
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
      if (status === 'dismissed') {
        const { error } = await supabase.from('abuse_reports').delete().eq('id', id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('abuse_reports').update({ status, resolution, reviewed_at: new Date().toISOString() }).eq('id', id);
        if (error) throw error;
      }
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
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => updateReport.mutate({ id: r.id, status: 'resolved', resolution: 'Approuvé par admin' })}>Résoudre</Button>
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => updateReport.mutate({ id: r.id, status: 'dismissed', resolution: 'Rejeté' })}>Rejeter</Button>
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
