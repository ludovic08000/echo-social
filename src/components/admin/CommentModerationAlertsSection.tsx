import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card } from '@/components/ui/card';
import { ShieldAlert, Ban, CheckCircle2, MessageSquareWarning, Clock, User } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';

interface Alert {
  id: string;
  user_id: string;
  comment_id: string | null;
  post_id: string | null;
  evidence_text: string;
  category: string;
  severity: string;
  ai_reasoning: string | null;
  strike_count: number;
  status: string;
  created_at: string;
  reviewed_at: string | null;
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'bg-destructive/15 text-destructive border-destructive/30',
  warning: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  info: 'bg-blue-500/15 text-blue-600 border-blue-500/30',
};

export function CommentModerationAlertsSection() {
  const qc = useQueryClient();
  const { user } = useAuth();

  const { data: alerts, isLoading } = useQuery({
    queryKey: ['admin-comment-alerts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('comment_moderation_alerts' as any)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data as unknown as Alert[]) || [];
    },
    refetchInterval: 30_000,
  });

  const { data: profiles } = useQuery({
    queryKey: ['admin-comment-alerts-profiles', alerts?.map(a => a.user_id)],
    queryFn: async () => {
      if (!alerts?.length) return new Map();
      const ids = [...new Set(alerts.map(a => a.user_id))];
      const { data } = await supabase.from('profiles').select('user_id, name, avatar_url').in('user_id', ids);
      return new Map((data || []).map(p => [p.user_id, p]));
    },
    enabled: !!alerts?.length,
  });

  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: 'reviewed' | 'dismissed' | 'banned' }) => {
      const { error } = await supabase
        .from('comment_moderation_alerts' as any)
        .update({ status, reviewed_by: user?.id, reviewed_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-comment-alerts'] });
    },
  });

  const banUser = useMutation({
    mutationFn: async ({ alert }: { alert: Alert }) => {
      if (!user) throw new Error('Non authentifié');
      const { error: banErr } = await supabase
        .from('banned_users')
        .insert({ user_id: alert.user_id, reason: `Modération auto Zeus: ${alert.category} (${alert.severity})`, banned_by: user.id });
      if (banErr && !banErr.message.includes('duplicate')) throw banErr;
      await supabase
        .from('comment_moderation_alerts' as any)
        .update({ status: 'banned', reviewed_by: user.id, reviewed_at: new Date().toISOString() })
        .eq('id', alert.id);
    },
    onSuccess: () => {
      toast({ title: '🚫 Utilisateur banni', description: 'Le compte a été suspendu.' });
      qc.invalidateQueries({ queryKey: ['admin-comment-alerts'] });
    },
    onError: (e: any) => toast({ title: 'Erreur', description: e.message, variant: 'destructive' }),
  });

  const pending = alerts?.filter(a => a.status === 'pending') || [];
  const handled = alerts?.filter(a => a.status !== 'pending') || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2" style={{ fontFamily: 'Playfair Display, serif' }}>
            <ShieldAlert className="w-6 h-6 text-primary" />
            Modération Zeus — Alertes
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Commentaires escaladés par Zeus avec preuves. Décidez de bannir ou non.
          </p>
        </div>
        <Badge variant="secondary" className="gap-1.5">
          <MessageSquareWarning className="w-3.5 h-3.5" />
          {pending.length} en attente
        </Badge>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Chargement…</p>}

      {!isLoading && pending.length === 0 && handled.length === 0 && (
        <Card className="p-8 text-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Aucune alerte. Zeus veille. ⚡</p>
        </Card>
      )}

      {pending.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">À examiner ({pending.length})</h3>
          <ScrollArea className="max-h-[60vh]">
            <div className="space-y-3 pr-3">
              {pending.map(a => (
                <AlertCard
                  key={a.id}
                  alert={a}
                  profile={profiles?.get(a.user_id)}
                  onBan={() => banUser.mutate({ alert: a })}
                  onDismiss={() => setStatus.mutate({ id: a.id, status: 'dismissed' })}
                  onReview={() => setStatus.mutate({ id: a.id, status: 'reviewed' })}
                />
              ))}
            </div>
          </ScrollArea>
        </section>
      )}

      {handled.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">Historique ({handled.length})</h3>
          <ScrollArea className="max-h-[40vh]">
            <div className="space-y-2 pr-3">
              {handled.map(a => (
                <Card key={a.id} className="p-3 opacity-70">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-muted-foreground truncate">
                        <span className="font-medium">{profiles?.get(a.user_id)?.name || 'Inconnu'}</span> — {a.category}
                      </p>
                      <p className="text-xs italic text-muted-foreground/80 truncate">"{a.evidence_text}"</p>
                    </div>
                    <Badge variant="outline" className="shrink-0">{a.status}</Badge>
                  </div>
                </Card>
              ))}
            </div>
          </ScrollArea>
        </section>
      )}
    </div>
  );
}

function AlertCard({ alert, profile, onBan, onDismiss, onReview }: {
  alert: Alert;
  profile: any;
  onBan: () => void;
  onDismiss: () => void;
  onReview: () => void;
}) {
  return (
    <Card className="p-4 border-l-4" style={{ borderLeftColor: 'hsl(var(--destructive))' }}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center shrink-0">
            <User className="w-4 h-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{profile?.name || 'Utilisateur inconnu'}</p>
            <p className="text-[11px] text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDistanceToNow(new Date(alert.created_at), { addSuffix: true, locale: fr })}
            </p>
          </div>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <Badge className={SEVERITY_STYLES[alert.severity] || ''} variant="outline">
            {alert.severity}
          </Badge>
          <Badge variant="secondary">strike #{alert.strike_count}</Badge>
        </div>
      </div>

      <div className="bg-muted/50 rounded-lg p-3 mb-3">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Preuve — commentaire</p>
        <p className="text-sm italic">"{alert.evidence_text}"</p>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
        <div>
          <span className="text-muted-foreground">Catégorie : </span>
          <span className="font-medium">{alert.category}</span>
        </div>
        {alert.ai_reasoning && (
          <div className="col-span-2">
            <span className="text-muted-foreground">Analyse Zeus : </span>
            <span>{alert.ai_reasoning}</span>
          </div>
        )}
      </div>

      <div className="flex gap-2 flex-wrap">
        <Button size="sm" variant="destructive" onClick={onBan} className="gap-1.5">
          <Ban className="w-3.5 h-3.5" />
          Bannir
        </Button>
        <Button size="sm" variant="outline" onClick={onReview} className="gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Avertissement OK
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Ignorer
        </Button>
      </div>
    </Card>
  );
}
