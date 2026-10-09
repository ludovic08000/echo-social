import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

type Row = {
  tip_id: string; creator_id: string; creator_name: string | null; live_stream_id: string | null;
  live_title: string | null; amount: number; commission_amount: number; creator_payout: number; paid_at: string;
};

const eur = (n: number) => `${Number(n || 0).toFixed(2).replace('.', ',')} €`;
const PERIODS = [{ d: 7, l: '7 j' }, { d: 30, l: '30 j' }, { d: 90, l: '90 j' }];

export function CreatorRevenueSection() {
  const [days, setDays] = useState(30);
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['admin-creator-revenue', days],
    queryFn: async () => {
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const { data, error } = await supabase.rpc('admin_creator_revenue', { p_since: since });
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  // Regroupement créateur → live (ou « Hors live »)
  const creators = useMemo(() => {
    const map = new Map<string, { name: string; total: number; mine: number; lives: Map<string, { title: string; total: number; mine: number; last: string; count: number }> }>();
    for (const r of data) {
      const c = map.get(r.creator_id) ?? { name: r.creator_name || 'Créateur', total: 0, mine: 0, lives: new Map() };
      c.total += Number(r.amount); c.mine += Number(r.commission_amount);
      const k = r.live_stream_id ?? 'none';
      const l = c.lives.get(k) ?? { title: r.live_stream_id ? (r.live_title || 'Live supprimé') : 'Hors live (profil)', total: 0, mine: 0, last: r.paid_at, count: 0 };
      l.total += Number(r.amount); l.mine += Number(r.commission_amount); l.count++;
      if (r.paid_at > l.last) l.last = r.paid_at;
      c.lives.set(k, l); map.set(r.creator_id, c);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [data]);

  const total = data.reduce((s, r) => s + Number(r.amount), 0);
  const mine = data.reduce((s, r) => s + Number(r.commission_amount), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">Revenus créateurs</h2>
        <div className="flex gap-1">
          {PERIODS.map(p => (
            <Button key={p.d} size="sm" variant={days === p.d ? 'default' : 'outline'} onClick={() => setDays(p.d)}>{p.l}</Button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Card className="p-3"><p className="text-xs text-muted-foreground">Total payé</p><p className="text-lg font-bold">{eur(total)}</p></Card>
        <Card className="p-3"><p className="text-xs text-muted-foreground">Ta part (25 %)</p><p className="text-lg font-bold text-primary">{eur(mine)}</p></Card>
        <Card className="p-3"><p className="text-xs text-muted-foreground">Paiements</p><p className="text-lg font-bold">{data.length}</p></Card>
      </div>
      {isLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto" /> :
       error ? <p className="text-sm text-destructive">Impossible de charger les revenus.</p> :
       creators.length === 0 ? <p className="text-sm text-muted-foreground">Aucun paiement sur cette période.</p> :
       creators.map(c => (
        <Card key={c.name + c.total} className="overflow-x-auto">
          <div className="flex justify-between p-3 border-b border-border">
            <span className="font-semibold">{c.name}</span>
            <span className="text-sm">{eur(c.total)} · ta part {eur(c.mine)}</span>
          </div>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Live</TableHead><TableHead className="text-right">Montant payé</TableHead>
              <TableHead className="text-right">Ta part</TableHead><TableHead>Dernier paiement</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {[...c.lives.values()].sort((a, b) => b.last.localeCompare(a.last)).map(l => (
                <TableRow key={l.title + l.last}>
                  <TableCell>{l.title}<span className="text-xs text-muted-foreground"> ({l.count})</span></TableCell>
                  <TableCell className="text-right">{eur(l.total)}</TableCell>
                  <TableCell className="text-right">{eur(l.mine)}</TableCell>
                  <TableCell>{new Date(l.last).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ))}
    </div>
  );
}
