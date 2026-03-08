import { useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BarChart3, TrendingUp, DollarSign, ShoppingBag } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';

type Period = '7d' | '30d' | '90d';

interface SalesAnalyticsProps {
  orders: any[];
  totalRevenue: number;
  totalSales: number;
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
            <Button
              key={p}
              size="sm"
              variant={period === p ? 'default' : 'ghost'}
              className="h-7 text-xs px-2"
              onClick={() => setPeriod(p)}
            >
              {p === '7d' ? '7j' : p === '30d' ? '30j' : '90j'}
            </Button>
          ))}
        </div>
      </div>

      {/* KPI cards */}
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

      {/* Revenue chart */}
      <Card>
        <CardContent className="p-3">
          <p className="text-xs font-medium mb-2 text-muted-foreground">Chiffre d'affaires (€)</p>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="date" tick={{ fontSize: 9 }} interval="preserveStartEnd" stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" />
                <Tooltip
                  contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid hsl(var(--border))' }}
                  formatter={(value: number) => [`${value.toFixed(2)}€`, 'CA']}
                />
                <Area type="monotone" dataKey="revenue" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.15)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Orders chart */}
      <Card>
        <CardContent className="p-3">
          <p className="text-xs font-medium mb-2 text-muted-foreground">Nombre de commandes</p>
          <div className="h-32">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="date" tick={{ fontSize: 9 }} interval="preserveStartEnd" stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 9 }} allowDecimals={false} stroke="hsl(var(--muted-foreground))" />
                <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid hsl(var(--border))' }} />
                <Bar dataKey="orders" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} name="Commandes" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
