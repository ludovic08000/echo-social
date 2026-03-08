import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Package, Search, Truck, CheckCircle2, Clock, MapPin, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';
import { OrderTracking } from './OrderTracking';

interface OrdersTableProps {
  orders: any[];
  viewMode: 'seller' | 'buyer';
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  pending: { label: 'En attente', color: 'bg-muted text-muted-foreground', icon: <Clock className="w-3 h-3" /> },
  paid: { label: 'Payée', color: 'bg-amber-500/10 text-amber-600', icon: <Package className="w-3 h-3" /> },
  shipped: { label: 'Expédiée', color: 'bg-blue-500/10 text-blue-600', icon: <Truck className="w-3 h-3" /> },
  delivered: { label: 'Livrée', color: 'bg-green-500/10 text-green-600', icon: <CheckCircle2 className="w-3 h-3" /> },
  cancelled: { label: 'Annulée', color: 'bg-destructive/10 text-destructive', icon: <Clock className="w-3 h-3" /> },
};

export function OrdersTable({ orders, viewMode }: OrdersTableProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [expandedTracking, setExpandedTracking] = useState<string | null>(null);

  const filtered = orders.filter((o: any) => {
    const matchSearch = !search || o.order_number?.toLowerCase().includes(search.toLowerCase()) ||
      o.tracking_number?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'all' || o.status === statusFilter;
    return matchSearch && matchStatus;
  });

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="N° commande ou suivi..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9 text-xs"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-32 h-9 text-xs">
            <SelectValue placeholder="Statut" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous</SelectItem>
            <SelectItem value="paid">Payée</SelectItem>
            <SelectItem value="shipped">Expédiée</SelectItem>
            <SelectItem value="delivered">Livrée</SelectItem>
            <SelectItem value="cancelled">Annulée</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center">
            <Package className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">Aucune commande trouvée</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((order: any) => {
            const status = STATUS_CONFIG[order.status] || STATUS_CONFIG.pending;
            const items = order.order_items || [];
            const isExpanded = expandedTracking === order.id;

            return (
              <Card key={order.id} className="overflow-hidden">
                <CardContent className="p-3 space-y-2">
                  {/* Header */}
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-bold font-mono">{order.order_number}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {new Date(order.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })}
                      </p>
                    </div>
                    <Badge variant="secondary" className={`${status.color} text-[10px] gap-1`}>
                      {status.icon}
                      {status.label}
                    </Badge>
                  </div>

                  {/* Items */}
                  <div className="space-y-1">
                    {items.map((item: any) => (
                      <div key={item.id} className="flex justify-between text-xs">
                        <span className="text-muted-foreground">{item.title} ×{item.quantity}</span>
                        <span className="font-medium">{Number(item.subtotal).toFixed(2)}€</span>
                      </div>
                    ))}
                  </div>

                  {/* Tracking number + expand button */}
                  {order.tracking_number && (
                    <div className="space-y-2">
                      <button
                        onClick={() => setExpandedTracking(isExpanded ? null : order.id)}
                        className="flex items-center gap-2 text-xs bg-secondary/50 rounded-lg px-2.5 py-1.5 w-full hover:bg-secondary/70 transition-colors"
                      >
                        <Truck className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                        <span className="font-mono text-[11px]">{order.tracking_number}</span>
                        <div className="ml-auto flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5"
                            onClick={(e) => {
                              e.stopPropagation();
                              window.open(`https://www.mondialrelay.fr/suivi-de-colis/?NumeroExpedition=${order.tracking_number}`, '_blank');
                            }}
                          >
                            <ExternalLink className="w-3 h-3" />
                          </Button>
                          {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </div>
                      </button>

                      {/* Expanded tracking timeline */}
                      {isExpanded && (
                        <div className="border border-border/40 rounded-lg p-3">
                          <OrderTracking trackingNumber={order.tracking_number} />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Relay */}
                  {order.shipping_relay_name && (
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <MapPin className="w-3 h-3 flex-shrink-0" />
                      {order.shipping_relay_name} — {order.shipping_relay_postcode} {order.shipping_relay_city}
                    </div>
                  )}

                  {/* Total */}
                  <div className="flex justify-between items-center pt-1 border-t border-border/40">
                    <span className="text-xs text-muted-foreground">Total</span>
                    <span className="text-sm font-bold">{Number(order.total).toFixed(2)}€</span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
