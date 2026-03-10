import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { cn } from '@/lib/utils';

export function SubscriptionsSection() {
  const { data: orders, isLoading } = useQuery({
    queryKey: ['admin-orders'],
    queryFn: async () => {
      const { data, error } = await supabase.from('orders').select('id, order_number, buyer_id, total, commission_amount, status, created_at').order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      const buyerIds = [...new Set(data?.map(o => o.buyer_id) || [])];
      const { data: profiles } = buyerIds.length > 0 ? await supabase.from('profiles').select('user_id, name').in('user_id', buyerIds) : { data: [] };
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
