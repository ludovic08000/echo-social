import { useState } from 'react';
import { useSellerProfile, useCreateSellerProfile, useSellerProducts, useDeleteProduct } from '@/hooks/useMarketplace';
import { useSellerOrders } from '@/hooks/useSellerOrders';
import { CreateProductDialog } from './CreateProductDialog';
import { OrderTracking } from './OrderTracking';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Store, Package, TrendingUp, Trash2, Eye, Truck, Download, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export function SellerDashboard() {
  const { data: seller, isLoading } = useSellerProfile();
  const { data: products = [] } = useSellerProducts();
  const { data: orders = [] } = useSellerOrders();
  const createSeller = useCreateSellerProfile();
  const deleteProduct = useDeleteProduct();
  const [storeName, setStoreName] = useState('');
  const [shippingOrderId, setShippingOrderId] = useState<string | null>(null);
  const [creatingLabel, setCreatingLabel] = useState(false);

  const handleCreateLabel = async (orderId: string) => {
    setCreatingLabel(true);
    setShippingOrderId(orderId);
    try {
      const { data, error } = await supabase.functions.invoke('mondial-relay', {
        body: {
          action: 'create_shipment',
          order_id: orderId,
          sender: {
            name: seller?.store_name || 'Vendeur',
            address: '',
            city: '',
            postcode: '',
            country: 'FR',
            email: '',
          },
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      toast.success(`Étiquette créée ! N° suivi : ${data.tracking_number}`);
    } catch (e: any) {
      toast.error(e.message || 'Erreur lors de la création de l\'étiquette');
    } finally {
      setCreatingLabel(false);
      setShippingOrderId(null);
    }
  };

  if (isLoading) {
    return <div className="space-y-4"><div className="skeleton h-32 w-full" /><div className="skeleton h-32 w-full" /></div>;
  }

  if (!seller) {
    return (
      <Card className="premium-card">
        <CardContent className="p-6 text-center space-y-4">
          <div className="w-16 h-16 rounded-2xl bg-premium-gradient flex items-center justify-center mx-auto">
            <Store className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-xl font-bold">Ouvrir votre boutique</h2>
          <p className="text-muted-foreground text-sm max-w-sm mx-auto">
            Vendez vos produits, créations ou services à la communauté. Vous touchez 100% du prix de vente — les frais de 5% sont à la charge de l'acheteur.
          </p>
          <div className="flex gap-2 max-w-xs mx-auto">
            <Input
              value={storeName}
              onChange={(e) => setStoreName(e.target.value)}
              placeholder="Nom de votre boutique"
            />
            <Button
              onClick={() => createSeller.mutate(storeName)}
              disabled={!storeName.trim() || createSeller.isPending}
            >
              Créer
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const paidOrders = orders.filter((o: any) => o.status === 'paid' || o.status === 'shipped' || o.status === 'delivered');

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="premium-card">
          <CardContent className="p-4 text-center">
            <Package className="w-5 h-5 mx-auto text-primary mb-1" />
            <p className="text-2xl font-bold">{products.length}</p>
            <p className="text-xs text-muted-foreground">Produits</p>
          </CardContent>
        </Card>
        <Card className="premium-card">
          <CardContent className="p-4 text-center">
            <TrendingUp className="w-5 h-5 mx-auto text-primary mb-1" />
            <p className="text-2xl font-bold">{seller.total_sales}</p>
            <p className="text-xs text-muted-foreground">Ventes</p>
          </CardContent>
        </Card>
        <Card className="premium-card">
          <CardContent className="p-4 text-center">
            <Store className="w-5 h-5 mx-auto text-primary mb-1" />
            <p className="text-2xl font-bold">{seller.total_revenue?.toFixed(0) || 0}€</p>
            <p className="text-xs text-muted-foreground">Revenus</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="products">
        <TabsList className="w-full">
          <TabsTrigger value="products" className="flex-1 gap-1.5 text-xs">
            <Package className="w-3.5 h-3.5" />
            Produits
          </TabsTrigger>
          <TabsTrigger value="orders" className="flex-1 gap-1.5 text-xs">
            <Truck className="w-3.5 h-3.5" />
            Commandes
          </TabsTrigger>
        </TabsList>

        <TabsContent value="products" className="space-y-4 mt-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">Mes produits</h2>
            <CreateProductDialog sellerId={seller.id} />
          </div>

          {products.length === 0 ? (
            <Card className="premium-card">
              <CardContent className="p-8 text-center">
                <Package className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground">Aucun produit encore. Ajoutez votre premier !</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {products.map((product) => (
                <div key={product.id} className="flex items-center gap-3 p-3 rounded-xl bg-card border border-border/40">
                  <img
                    src={product.thumbnail_url || product.images?.[0] || '/placeholder.svg'}
                    alt={product.title}
                    className="w-12 h-12 rounded-lg object-cover flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-medium truncate">{product.title}</h4>
                    <p className="text-sm font-bold text-primary">{product.price.toFixed(2)}€</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground">{product.view_count} <Eye className="w-3 h-3 inline" /></span>
                    <Link to={`/marketplace/product/${product.id}`}>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <Eye className="w-4 h-4" />
                      </Button>
                    </Link>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => deleteProduct.mutate(product.id)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="orders" className="space-y-3 mt-3">
          <h2 className="text-lg font-bold">Commandes à expédier</h2>

          {paidOrders.length === 0 ? (
            <Card className="premium-card">
              <CardContent className="p-8 text-center">
                <Truck className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground">Aucune commande en attente</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {paidOrders.map((order: any) => (
                <Card key={order.id} className="overflow-hidden">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-bold">{order.order_number}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(order.created_at).toLocaleDateString('fr-FR')}
                        </p>
                      </div>
                      <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${
                        order.status === 'shipped' ? 'bg-blue-500/10 text-blue-500' :
                        order.status === 'delivered' ? 'bg-green-500/10 text-green-500' :
                        'bg-amber-500/10 text-amber-500'
                      }`}>
                        {order.status === 'paid' ? 'À expédier' : order.status === 'shipped' ? 'Expédié' : 'Livré'}
                      </span>
                    </div>

                    {/* Relay info */}
                    {order.shipping_relay_name && (
                      <div className="text-xs bg-secondary/50 rounded-lg p-2 space-y-0.5">
                        <p className="font-semibold flex items-center gap-1">
                          <Truck className="w-3 h-3 text-primary" />
                          Mondial Relay : {order.shipping_relay_name}
                        </p>
                        <p className="text-muted-foreground">{order.shipping_relay_address}</p>
                        <p className="text-muted-foreground">{order.shipping_relay_postcode} {order.shipping_relay_city}</p>
                      </div>
                    )}

                    {/* Items */}
                    <div className="space-y-1">
                      {order.order_items?.map((item: any) => (
                        <div key={item.id} className="flex justify-between text-xs">
                          <span>{item.title} x{item.quantity}</span>
                          <span className="font-medium">{item.subtotal.toFixed(2)}€</span>
                        </div>
                      ))}
                    </div>

                    {/* Actions */}
                    {order.status === 'paid' && (
                      <Button
                        size="sm"
                        className="w-full"
                        onClick={() => handleCreateLabel(order.id)}
                        disabled={creatingLabel && shippingOrderId === order.id}
                      >
                        {creatingLabel && shippingOrderId === order.id ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <Truck className="w-4 h-4 mr-2" />
                        )}
                        Créer étiquette Mondial Relay
                      </Button>
                    )}

                    {order.shipping_label_url && (
                      <a href={order.shipping_label_url} target="_blank" rel="noopener noreferrer">
                        <Button variant="outline" size="sm" className="w-full">
                          <Download className="w-4 h-4 mr-2" />
                          Télécharger l'étiquette
                        </Button>
                      </a>
                    )}

                    {order.tracking_number && (
                      <OrderTracking trackingNumber={order.tracking_number} />
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
