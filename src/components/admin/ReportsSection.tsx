import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Flag, CheckCircle, XCircle } from 'lucide-react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { motion } from 'framer-motion';

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

  const pendingCount = reports?.filter(r => r.status === 'pending').length || 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Flag className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-bold text-foreground">Signalements</h2>
        </div>
        {pendingCount > 0 && <Badge variant="destructive" className="shrink-0">{pendingCount} en attente</Badge>}
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Chargement…</div>
      ) : !reports?.length ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Aucun signalement</div>
      ) : (
        <div className="space-y-2">
          {reports.map((r, i) => (
            <motion.div key={r.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.02 }}>
              <Card className={r.status === 'pending' ? 'border-amber-500/30' : ''}>
                <CardContent className="p-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-foreground truncate">{r.reportedName}</span>
                        <Badge variant="secondary" className="text-[10px] shrink-0">{r.report_type}</Badge>
                        <Badge variant={r.status === 'pending' ? 'destructive' : 'secondary'} className="text-[10px] shrink-0">
                          {r.status === 'pending' ? 'En attente' : r.status === 'resolved' ? 'Résolu' : r.status}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Signalé par <span className="font-medium">{r.reporterName}</span> · {format(new Date(r.created_at), 'dd/MM HH:mm', { locale: fr })}
                      </p>
                      {r.description && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{r.description}</p>}
                    </div>
                    {r.status === 'pending' && (
                      <div className="flex gap-1 shrink-0">
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-green-600 hover:bg-green-500/10" onClick={() => updateReport.mutate({ id: r.id, status: 'resolved', resolution: 'Approuvé' })} title="Résoudre">
                          <CheckCircle className="w-4 h-4" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => updateReport.mutate({ id: r.id, status: 'dismissed', resolution: 'Rejeté' })} title="Rejeter">
                          <XCircle className="w-4 h-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
