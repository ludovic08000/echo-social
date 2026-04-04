import { useEffect, useMemo, useState } from 'react';
import { useSellerProfile, useCreateSellerProfile, useSellerProducts, useDeleteProduct } from '@/hooks/useMarketplace';
import { useSellerOrders } from '@/hooks/useSellerOrders';
import { CreateProductDialog } from './CreateProductDialog';
import { OrderTracking } from './OrderTracking';
import { SalesAnalytics } from './SalesAnalytics';
import { OrdersTable } from './OrdersTable';
import { AIProductHelper } from './AIProductHelper';
import { AISalesCoach } from './AISalesCoach';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Store, Package, TrendingUp, Trash2, Eye, Truck, Loader2, CheckCircle2, Video, ShieldCheck, ShieldAlert, Upload, FileText, BarChart3, Bot, Sparkles } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { escapeHtml } from '@/lib/sanitizeUrl';


export function SellerDashboard() {
  const [searchParams] = useSearchParams();
  const { data: seller, isLoading } = useSellerProfile();
  const { data: products = [] } = useSellerProducts();
  const { data: orders = [], refetch: refetchOrders } = useSellerOrders();
  const createSeller = useCreateSellerProfile();
  const deleteProduct = useDeleteProduct();
  const [storeName, setStoreName] = useState('');
  const [markingDelivered, setMarkingDelivered] = useState<string | null>(null);
  const [uploadingVideo, setUploadingVideo] = useState<string | null>(null);
  const [analyzingVideo, setAnalyzingVideo] = useState<string | null>(null);
  const [orderWeights, setOrderWeights] = useState<Record<string, string>>({});
  const [creatingShipment, setCreatingShipment] = useState<string | null>(null);

  const estimateRelayShipping = (weightGrams: number) => {
    const basePerParcel = 4.2;
    const weightExtra =
      weightGrams <= 500 ? 0 :
      weightGrams <= 1000 ? 0.8 :
      weightGrams <= 2000 ? 1.6 :
      weightGrams <= 5000 ? 2.8 : 4.5;
    return Math.round((basePerParcel + weightExtra) * 100) / 100;
  };
  const [sellerTab, setSellerTab] = useState<string>(
    searchParams.get('sellerTab') || 'products'
  );

  const paidOrders = useMemo(
    () => orders.filter((o: any) => o.status === 'paid' || o.status === 'shipped' || o.status === 'delivered'),
    [orders],
  );

  useEffect(() => {
    if (searchParams.get('sellerTab') === 'orders' || paidOrders.length > 0) {
      setSellerTab('orders');
    }
  }, [searchParams, paidOrders.length]);

  const generateDeliverySlip = (order: any) => {
    const items = order.order_items || [];
    const relayName = order.shipping_relay_name || '—';
    const relayAddress = order.shipping_relay_address || '';
    const relayCity = `${order.shipping_relay_postcode || ''} ${order.shipping_relay_city || ''}`.trim();
    const date = new Date(order.created_at).toLocaleDateString('fr-FR');
    const weightGrams = Math.max(100, Number(orderWeights[order.id]) || 500);
    const shippingCost = estimateRelayShipping(weightGrams);
    const weightLabel = weightGrams >= 1000 ? `${(weightGrams / 1000).toFixed(1)} kg` : `${weightGrams} g`;

    const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>Bordereau ${order.order_number}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,sans-serif;padding:40px;color:#111;font-size:13px}
h1{font-size:22px;margin-bottom:4px}
.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:30px;border-bottom:3px solid #111;padding-bottom:16px}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:30px}
.box{border:1px solid #ccc;border-radius:8px;padding:16px}
.box h3{font-size:13px;text-transform:uppercase;color:#666;margin-bottom:8px;letter-spacing:0.5px}
table{width:100%;border-collapse:collapse;margin-bottom:24px}
th{background:#f5f5f5;text-align:left;padding:8px 12px;border:1px solid #ddd;font-size:12px}
td{padding:8px 12px;border:1px solid #ddd}
.total-row td{font-weight:bold;background:#f9f9f9}
.footer{margin-top:40px;padding-top:16px;border-top:1px solid #ddd;display:flex;justify-content:space-between}
.sig-box{border:1px dashed #ccc;width:200px;height:80px;display:flex;align-items:flex-end;justify-content:center;padding:8px;font-size:11px;color:#999}
@media print{body{padding:20px}}
</style></head><body>
<div class="header"><div><h1>BORDEREAU DE LIVRAISON</h1><p style="color:#666">N° ${order.order_number}</p></div><div style="text-align:right"><p><strong>${seller?.store_name || 'Vendeur'}</strong></p><p style="color:#666">Date : ${date}</p></div></div>
<div class="info-grid">
<div class="box"><h3>Expéditeur</h3><p><strong>${seller?.store_name || 'Vendeur'}</strong></p></div>
<div class="box"><h3>Destinataire — Point Relais</h3><p><strong>${relayName}</strong></p><p>${relayAddress}</p><p>${relayCity}</p>${order.shipping_relay_country ? `<p>${order.shipping_relay_country}</p>` : ''}</div>
</div>
<table><thead><tr><th>Produit</th><th style="width:60px;text-align:center">Qté</th><th style="width:100px;text-align:right">Prix unit.</th><th style="width:100px;text-align:right">Total</th></tr></thead><tbody>
${items.map((item: any) => `<tr><td>${item.title}</td><td style="text-align:center">${item.quantity}</td><td style="text-align:right">${Number(item.price).toFixed(2)} €</td><td style="text-align:right">${Number(item.subtotal).toFixed(2)} €</td></tr>`).join('')}
<tr class="total-row"><td colspan="3" style="text-align:right">TOTAL</td><td style="text-align:right">${Number(order.total).toFixed(2)} €</td></tr>
</tbody></table>
${order.tracking_number ? `<p style="margin-bottom:16px"><strong>N° de suivi :</strong> ${order.tracking_number}</p>` : ''}
<p style="margin-bottom:16px"><strong>Poids du colis :</strong> ${weightLabel} · <strong>Frais Mondial Relay :</strong> ${shippingCost.toFixed(2)} €</p>
<div class="footer"><div class="sig-box">Signature expéditeur</div><div class="sig-box">Signature réceptionnaire</div></div>
<script>window.onload=()=>window.print()</script>
</body></html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const handlePackingVideoUpload = async (orderId: string, file: File) => {
    setUploadingVideo(orderId);
    try {
      const ext = file.name.split('.').pop() || 'mp4';
      const filePath = `packing/${orderId}_${Date.now()}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from('videos')
        .upload(filePath, file, { contentType: file.type });
      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('videos')
        .getPublicUrl(filePath);

      setUploadingVideo(null);
      setAnalyzingVideo(orderId);

      const { data, error } = await supabase.functions.invoke('verify-packing-video', {
        body: { order_id: orderId, video_url: publicUrl },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      if (data.status === 'verified') {
        toast.success("✅ Vidéo d'emballage vérifiée ! Vous pouvez créer l'étiquette.");
      } else {
        toast.error(`❌ Vidéo rejetée : ${data.analysis?.summary || 'Manipulation détectée'}`);
      }
      refetchOrders();
    } catch (e: any) {
      toast.error(e.message || "Erreur lors de l'upload vidéo");
    } finally {
      setUploadingVideo(null);
      setAnalyzingVideo(null);
    }
  };

  const markAsDelivered = async (order: any) => {
    setMarkingDelivered(order.id);
    try {
      const { error: orderError } = await supabase
        .from('orders')
        .update({ status: 'delivered' as any, delivered_at: new Date().toISOString() })
        .eq('id', order.id);
      if (orderError) throw orderError;

      const productIds = (order.order_items || []).map((item: any) => item.product_id).filter(Boolean);
      if (productIds.length > 0) {
        const { error: productError } = await supabase
          .from('products')
          .update({ is_active: false })
          .in('id', productIds);
        if (productError) console.error('Failed to deactivate products:', productError);
      }

      toast.success('Commande marquée comme livrée !');
      refetchOrders();
    } catch (e: any) {
      toast.error(e.message || 'Erreur');
    } finally {
      setMarkingDelivered(null);
    }
  };

  const createMondialRelayShipment = async (order: any) => {
    setCreatingShipment(order.id);
    try {
      const weightGrams = Math.max(100, Number(orderWeights[order.id]) || 500);
      const { data, error } = await supabase.functions.invoke('mondial-relay', {
        body: {
          action: 'create_shipment',
          order_id: order.id,
          package: { weight_grams: weightGrams },
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      toast.success(`✅ Expédition créée ! N° suivi : ${data.tracking_number}`);
      if (data.label_url) {
        window.open(data.label_url, '_blank');
      }
      refetchOrders();
    } catch (e: any) {
      toast.error(e.message || "Erreur lors de la création de l'expédition");
    } finally {
      setCreatingShipment(null);
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
              variant="premium"
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

  const needsPackingVideo = (_order: any) => false; // Temporarily disabled for testing

  const renderPackingVideoSection = (_order: any) => {
    // Temporarily disabled for testing
    return null;
  };

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

      <Tabs value={sellerTab} onValueChange={setSellerTab}>
        <TabsList className="w-full grid grid-cols-5">
          <TabsTrigger value="products" className="gap-1 text-[10px] px-1">
            <Package className="w-3 h-3" />
            Produits
          </TabsTrigger>
          <TabsTrigger value="orders" className="gap-1 text-[10px] px-1">
            <Truck className="w-3 h-3" />
            Commandes
          </TabsTrigger>
          <TabsTrigger value="analytics" className="gap-1 text-[10px] px-1">
            <BarChart3 className="w-3 h-3" />
            Stats
          </TabsTrigger>
          <TabsTrigger value="ai-desc" className="gap-1 text-[10px] px-1">
            <Sparkles className="w-3 h-3" />
            IA Desc
          </TabsTrigger>
          <TabsTrigger value="ai-coach" className="gap-1 text-[10px] px-1">
            <Bot className="w-3 h-3" />
            Coach
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
                      disabled={deleteProduct.isPending}
                      onClick={() => {
                        if (window.confirm('Supprimer ce produit ? Cette action est irréversible.')) {
                          deleteProduct.mutate(product.id);
                        }
                      }}
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

                    {/* Packing video for orders >= 100€ */}
                    {renderPackingVideoSection(order)}

                    {/* Weight selection & delivery slip */}
                    {order.status === 'paid' && (
                      needsPackingVideo(order) ? (
                        <p className="text-[11px] text-muted-foreground text-center py-1">⚠️ Vidéo d'emballage requise avant de générer le bordereau</p>
                      ) : (
                        <div className="space-y-2">
                          <div className="rounded-lg border border-border/60 bg-card/60 p-3 space-y-2">
                            <p className="text-xs font-medium flex items-center gap-1.5">
                              <Package className="w-3.5 h-3.5 text-primary" />
                              Poids du colis (grammes)
                            </p>
                            <div className="flex gap-2 flex-wrap">
                              {[250, 500, 1000, 2000, 5000, 10000].map((w) => (
                                <Button
                                  key={w}
                                  size="sm"
                                  variant={Number(orderWeights[order.id] || '500') === w ? 'default' : 'outline'}
                                  className="h-7 text-xs px-2"
                                  onClick={() => setOrderWeights((prev) => ({ ...prev, [order.id]: String(w) }))}
                                >
                                  {w >= 1000 ? `${w / 1000}kg` : `${w}g`}
                                </Button>
                              ))}
                            </div>
                            <Input
                              type="number"
                              min={100}
                              placeholder="Poids personnalisé (g)"
                              value={orderWeights[order.id] || '500'}
                              onChange={(e) => setOrderWeights((prev) => ({ ...prev, [order.id]: e.target.value }))}
                              className="h-8 text-xs"
                            />
                            <p className="text-[11px] text-muted-foreground">
                              Frais Mondial Relay estimés : <span className="font-semibold text-foreground">{estimateRelayShipping(Math.max(100, Number(orderWeights[order.id]) || 500)).toFixed(2)}€</span>
                            </p>
                          </div>
                          <Button size="sm" variant="premium" className="w-full" onClick={() => generateDeliverySlip(order)}>
                             <FileText className="w-4 h-4 mr-2" />
                             Générer le bordereau de livraison (PDF)
                          </Button>
                          {!order.tracking_number && order.shipping_relay_id && (
                            <Button
                              size="sm"
                              variant="premium"
                              className="w-full"
                              onClick={() => createMondialRelayShipment(order)}
                              disabled={creatingShipment === order.id}
                            >
                              {creatingShipment === order.id ? (
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              ) : (
                                <Truck className="w-4 h-4 mr-2" />
                              )}
                              Créer l'expédition Mondial Relay
                            </Button>
                          )}
                          {!order.tracking_number && !order.shipping_relay_id && (
                            <Button
                              size="sm"
                              variant="premium"
                              className="w-full"
                              onClick={() => createMondialRelayShipment(order)}
                              disabled={creatingShipment === order.id}
                            >
                              {creatingShipment === order.id ? (
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              ) : (
                                <Truck className="w-4 h-4 mr-2" />
                              )}
                              Créer l'expédition & obtenir le suivi
                            </Button>
                          )}
                        </div>
                      )
                    )}

                    {order.tracking_number && (
                      <OrderTracking trackingNumber={order.tracking_number} />
                    )}

                    {order.status === 'shipped' && (
                      <Button
                        size="sm"
                        variant="premium"
                        className="w-full"
                        onClick={() => markAsDelivered(order)}
                        disabled={markingDelivered === order.id}
                      >
                        {markingDelivered === order.id ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <CheckCircle2 className="w-4 h-4 mr-2" />
                        )}
                        Marquer comme livré
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Analytics Tab */}
        <TabsContent value="analytics" className="mt-3">
          <SalesAnalytics
            orders={orders}
            totalRevenue={seller.total_revenue || 0}
            totalSales={seller.total_sales || 0}
          />
        </TabsContent>

        {/* AI Description Tab */}
        <TabsContent value="ai-desc" className="mt-3">
          <AIProductHelper />
        </TabsContent>

        {/* AI Coach Tab */}
        <TabsContent value="ai-coach" className="mt-3">
          <AISalesCoach
            sellerName={seller.store_name}
            totalSales={seller.total_sales || 0}
            totalRevenue={seller.total_revenue || 0}
            productCount={products.length}
            orderCount={paidOrders.length}
            products={products.map((p: any) => ({ title: p.title, price: p.price, category: p.category, stock: p.stock_quantity, created: p.created_at, description: p.description, thumbnail: p.thumbnail_url, images: p.images, productType: p.product_type }))}
            recentOrders={paidOrders.slice(0, 20).map((o: any) => ({ total: o.total, status: o.status, date: o.created_at, items: o.order_items?.length || 0 }))}
            rating={seller.rating_average}
            ratingCount={seller.rating_count || 0}
          />
        </TabsContent>
      </Tabs>

    </div>
  );
}
