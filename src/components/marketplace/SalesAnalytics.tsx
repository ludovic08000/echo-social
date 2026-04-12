import { useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BarChart3, TrendingUp, DollarSign, ShoppingBag } from 'lucide-react';

type Period = '7d' | '30d' | '90d';

interface SalesAnalyticsProps {
  orders: any[];
  totalRevenue: number;
  totalSales: number;
}

function NativeBarChart({ data, color, suffix = '' }: { data: { label: string; value: number }[]; color: string; suffix?: string }) {
  const max = Math.max(...data.map(d => d.value), 1);
  const [hovered, setHovered] = useState<number | null>(null);
  return (
    <div>
      {hovered !== null && (
        <p className="text-[10px] text-foreground font-medium mb-1">{data[hovered].label} — {data[hovered].value}{suffix}</p>
      )}
      <div className="flex items-end gap-[2px] h-24">
        {data.map((d, i) => (
          <div
            key={i}
            className="flex-1 min-w-0 rounded-t transition-all cursor-pointer"
            style={{ height: `${Math.max((d.value / max) * 100, 2)}%`, backgroundColor: hovered === i ? color : `color-mix(in srgb, ${color} 40%, transparent)` }}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
      </div>
      <div className="flex justify-between text-[9px] text-muted-foreground mt-1">
        <span>{data[0]?.label}</span>
        <span>{data[data.length - 1]?.label}</span>
      </div>
    </div>
  );
}

export function SalesAnalytics({ orders, totalRevenue, totalSales }: SalesAnalyticsProps) {
  const [period, setPeriod] = useState<Period>('30d');

  const chartData = useMemo(() => {
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
    const now = new Date();
    const data: { date: string; revenue: number; orders: number }[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const label = d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });

      const dayOrders = orders.filter((o: any) => {
        const orderDate = new Date(o.paid_at || o.created_at).toISOString().split('T')[0];
        return orderDate === dateStr && (o.status === 'paid' || o.status === 'shipped' || o.status === 'delivered');
      });

      data.push({
        date: label,
        revenue: dayOrders.reduce((s: number, o: any) => s + Number(o.subtotal || 0), 0),
        orders: dayOrders.length,
      });
    }
    return data;
  }, [orders, period]);

  const periodRevenue = chartData.reduce((s, d) => s + d.revenue, 0);
  const periodOrders = chartData.reduce((s, d) => s + d.orders, 0);
  const avgOrderValue = periodOrders > 0 ? periodRevenue / periodOrders : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-primary" />
          Statistiques de vente
        </h3>
        <div className="flex gap-1">
          {(['7d', '30d', '90d'] as Period[]).map((p) => (
            <Button key={p} size="sm" variant={period === p ? 'default' : 'ghost'} className="h-7 text-xs px-2" onClick={() => setPeriod(p)}>
              {p === '7d' ? '7j' : p === '30d' ? '30j' : '90j'}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="p-3 text-center">
            <DollarSign className="w-4 h-4 mx-auto text-primary mb-1" />
            <p className="text-lg font-bold">{periodRevenue.toFixed(0)}€</p>
            <p className="text-[10px] text-muted-foreground">CA période</p>
          </CardContent>
        </Card>
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="p-3 text-center">
            <ShoppingBag className="w-4 h-4 mx-auto text-primary mb-1" />
            <p className="text-lg font-bold">{periodOrders}</p>
            <p className="text-[10px] text-muted-foreground">Commandes</p>
          </CardContent>
        </Card>
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="p-3 text-center">
            <TrendingUp className="w-4 h-4 mx-auto text-primary mb-1" />
            <p className="text-lg font-bold">{avgOrderValue.toFixed(0)}€</p>
            <p className="text-[10px] text-muted-foreground">Panier moyen</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-3">
          <p className="text-xs font-medium mb-2 text-muted-foreground">Chiffre d'affaires (€)</p>
          <NativeBarChart data={chartData.map(d => ({ label: d.date, value: d.revenue }))} color="hsl(var(--primary))" suffix="€" />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-3">
          <p className="text-xs font-medium mb-2 text-muted-foreground">Nombre de commandes</p>
          <NativeBarChart data={chartData.map(d => ({ label: d.date, value: d.orders }))} color="hsl(var(--primary))" />
        </CardContent>
      </Card>
    </div>
  );
}
