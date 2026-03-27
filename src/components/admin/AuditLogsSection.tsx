import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Search, Download, ScrollText, Filter } from 'lucide-react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

const EVENT_TYPES = [
  { value: 'all', label: 'Tous les événements' },
  { value: 'message_sent', label: 'Message envoyé' },
  { value: 'post_created', label: 'Publication créée' },
  { value: 'post_deleted', label: 'Publication supprimée' },
  { value: 'account_reported', label: 'Signalement' },
  { value: 'ban_applied', label: 'Bannissement' },
  { value: 'live_started', label: 'Live démarré' },
  { value: 'login', label: 'Connexion' },
  { value: 'media_uploaded', label: 'Média uploadé' },
];

const EVENT_COLORS: Record<string, string> = {
  message_sent: 'bg-blue-500/10 text-blue-600',
  post_created: 'bg-green-500/10 text-green-600',
  post_deleted: 'bg-orange-500/10 text-orange-600',
  account_reported: 'bg-red-500/10 text-red-600',
  ban_applied: 'bg-red-600/10 text-red-700',
  live_started: 'bg-purple-500/10 text-purple-600',
  login: 'bg-sky-500/10 text-sky-600',
  media_uploaded: 'bg-teal-500/10 text-teal-600',
};

export function AuditLogsSection() {
  const [search, setSearch] = useState('');
  const [eventFilter, setEventFilter] = useState('all');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const { data, isLoading } = useQuery({
    queryKey: ['admin-audit-logs', search, eventFilter, page],
    queryFn: async () => {
      // First get profiles matching search
      let userIds: string[] | null = null;
      if (search.trim()) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('user_id')
          .ilike('name', `%${search}%`)
          .limit(100);
        userIds = profiles?.map(p => p.user_id) || [];
        if (userIds.length === 0) return { logs: [], profiles: {} };
      }

      let query = supabase
        .from('audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      if (userIds) query = query.in('user_id', userIds);
      if (eventFilter !== 'all') query = query.eq('event_type', eventFilter);

      const { data: logs, error } = await query;
      if (error) throw error;

      // Fetch profile names for all user_ids and target_user_ids
      const allIds = [...new Set([
        ...(logs?.map(l => l.user_id) || []),
        ...(logs?.map(l => l.target_user_id).filter(Boolean) || []),
      ])];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', allIds);

      const profileMap: Record<string, string> = {};
      profiles?.forEach(p => { profileMap[p.user_id] = p.name || 'Inconnu'; });

      return { logs: logs || [], profiles: profileMap };
    },
  });

  const handleExport = () => {
    if (!data?.logs?.length) return;
    const csv = [
      'Date,Utilisateur,Événement,Cible,Statut,Raison',
      ...data.logs.map(l => [
        format(new Date(l.created_at), 'yyyy-MM-dd HH:mm:ss'),
        data.profiles[l.user_id] || l.user_id,
        l.event_type,
        l.target_user_id ? (data.profiles[l.target_user_id] || l.target_user_id) : '',
        l.status || '',
        l.reason_code || '',
      ].map(v => `"${v}"`).join(','))
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-logs-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ScrollText className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-bold text-foreground">Journal d'audit</h2>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-xs">
            Rétention : 6 mois
          </Badge>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleExport} disabled={!data?.logs?.length}>
            <Download className="w-3 h-3 mr-1" /> Exporter CSV
          </Button>
        </div>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Rechercher par nom, prénom..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(0); }}
            className="pl-9"
          />
        </div>
        <Select value={eventFilter} onValueChange={v => { setEventFilter(v); setPage(0); }}>
          <SelectTrigger className="w-52">
            <Filter className="w-3 h-3 mr-1" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EVENT_TYPES.map(et => (
              <SelectItem key={et.value} value={et.value}>{et.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Utilisateur</TableHead>
              <TableHead>Événement</TableHead>
              <TableHead>Cible</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead>Détails</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : !data?.logs?.length ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Aucun événement trouvé</TableCell></TableRow>
            ) : data.logs.map(log => (
              <TableRow key={log.id}>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {format(new Date(log.created_at), 'dd/MM/yy HH:mm:ss', { locale: fr })}
                </TableCell>
                <TableCell className="text-sm font-medium">
                  {data.profiles[log.user_id] || log.user_id.slice(0, 8)}
                </TableCell>
                <TableCell>
                  <Badge className={`text-[10px] ${EVENT_COLORS[log.event_type] || 'bg-secondary text-secondary-foreground'}`}>
                    {EVENT_TYPES.find(e => e.value === log.event_type)?.label || log.event_type}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm">
                  {log.target_user_id ? (data.profiles[log.target_user_id] || log.target_user_id.slice(0, 8)) : '-'}
                </TableCell>
                <TableCell>
                  <Badge variant={log.status === 'success' ? 'secondary' : log.status === 'blocked' ? 'destructive' : 'outline'} className="text-[10px]">
                    {log.status || '-'}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground max-w-[150px] truncate">
                  {log.reason_code || (log.conversation_id ? `Conv: ${log.conversation_id.slice(0, 8)}` : log.post_id ? `Post: ${log.post_id.slice(0, 8)}` : '-')}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Page {page + 1} • {data?.logs?.length || 0} résultats
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
            Précédent
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={(data?.logs?.length || 0) < PAGE_SIZE} onClick={() => setPage(p => p + 1)}>
            Suivant
          </Button>
        </div>
      </div>

      <div className="p-3 rounded-lg bg-muted/50 text-xs text-muted-foreground space-y-1">
        <p><strong>Conformité RGPD/CNIL :</strong> Ce journal ne contient aucun contenu de message, mot de passe, ou donnée sensible.</p>
        <p>Seules les métadonnées d'événements sont conservées. Purge automatique après 6 mois.</p>
        <p>Accès réservé aux administrateurs. Tout export est horodaté.</p>
      </div>
    </div>
  );
}
