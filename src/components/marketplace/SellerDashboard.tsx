import { useEffect, useMemo, useRef, useState } from 'react';
import { useSellerProfile, useCreateSellerProfile, useSellerProducts, useDeleteProduct } from '@/hooks/useMarketplace';
import { useSellerOrders } from '@/hooks/useSellerOrders';
import { CreateProductDialog } from './CreateProductDialog';
import { OrderTracking } from './OrderTracking';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Store, Package, TrendingUp, Trash2, Eye, Truck, Download, Loader2, CheckCircle2, Video, ShieldCheck, ShieldAlert, Upload, FileText } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';


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
  const [sellerTab, setSellerTab] = useState<'products' | 'orders'>(
    searchParams.get('sellerTab') === 'orders' ? 'orders' : 'products'
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

  const openLabelEditor = (order: any) => {
    setSelectedOrder(order);
    setLabelForm({
      weightGrams: String(order.shipping_weight_grams || 500),
      parcels: '1',
      lengthCm: '',
      sizeCode: '',
      senderName: seller?.store_name || 'Vendeur',
      senderAddress: order.shipping_relay_address || '',
      senderCity: order.shipping_relay_city || '',
      senderPostcode: order.shipping_relay_postcode || '',
      senderCountry: order.shipping_relay_country || 'FR',
      senderPhone: '',
      senderEmail: '',
    });
    setLabelEditorOpen(true);
  };

  const submitLabelCreation = async () => {
    if (!selectedOrder) return;

    const weight = Math.max(100, Number(labelForm.weightGrams) || 500);
    const parcels = Math.max(1, Number(labelForm.parcels) || 1);
    const lengthCm = Number(labelForm.lengthCm);

    await handleCreateLabel(selectedOrder.id, {
      sender: {
        name: labelForm.senderName.trim() || seller?.store_name || 'Vendeur',
        address: labelForm.senderAddress.trim(),
        city: labelForm.senderCity.trim(),
        postcode: labelForm.senderPostcode.trim(),
        country: (labelForm.senderCountry || 'FR').trim().toUpperCase(),
        phone: labelForm.senderPhone.trim(),
        email: labelForm.senderEmail.trim(),
      },
      parcel: {
        weight_grams: weight,
        parcels,
        length_cm: Number.isFinite(lengthCm) && lengthCm > 0 ? lengthCm : undefined,
        size_code: labelForm.sizeCode.trim() || undefined,
      },
    });
  };

  useEffect(() => {
    const focusOrderId = searchParams.get('order_success');
    if (!focusOrderId || autoOpenedOrderRef.current === focusOrderId) return;

    if (orders.length === 0) {
      refetchOrders();
      return;
    }

    const orderToEdit = orders.find((order: any) => order.id === focusOrderId);
    if (!orderToEdit) return;

    setSellerTab('orders');
    openLabelEditor(orderToEdit);
    autoOpenedOrderRef.current = focusOrderId;
  }, [searchParams, orders, refetchOrders]);

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

  const needsPackingVideo = (order: any) => order.total >= 100 && order.packing_video_status !== 'verified';

  const renderPackingVideoSection = (order: any) => {
    if (order.total < 100 || order.status !== 'paid') return null;
    const status = order.packing_video_status || 'none';

    return (
      <div className="rounded-xl border border-border/50 p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <Video className="w-4 h-4 text-primary" />
          Vidéo d'emballage obligatoire (+100€)
        </div>

        {status === 'none' && (
          <>
            <p className="text-[11px] text-muted-foreground">Filmez l'emballage sans coupure. L'IA vérifiera l'authenticité.</p>
            <label className="cursor-pointer">
              <input type="file" accept="video/*" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePackingVideoUpload(order.id, f); }}
                disabled={!!uploadingVideo || !!analyzingVideo} />
              <div className="flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-primary/10 text-primary text-xs font-semibold hover:bg-primary/20 transition-colors">
                {uploadingVideo === order.id ? (<><Loader2 className="w-4 h-4 animate-spin" /> Upload...</>)
                  : analyzingVideo === order.id ? (<><Loader2 className="w-4 h-4 animate-spin" /> Analyse IA...</>)
                  : (<><Upload className="w-4 h-4" /> Uploader la vidéo</>)}
              </div>
            </label>
          </>
        )}

        {status === 'analyzing' && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Analyse IA en cours...</div>
        )}

        {status === 'verified' && (
          <div className="flex items-center gap-2 text-xs text-green-600"><ShieldCheck className="w-4 h-4" /> Vidéo vérifiée ✓</div>
        )}

        {(status === 'rejected' || status === 'error') && (
          <div className="space-y-1.5">
            <div className={`flex items-center gap-2 text-xs ${status === 'rejected' ? 'text-destructive' : 'text-muted-foreground'}`}>
              <ShieldAlert className="w-4 h-4" />
              {status === 'rejected' ? 'Vidéo rejetée — Manipulation détectée' : 'Erreur — Réessayer'}
            </div>
            <label className="cursor-pointer">
              <input type="file" accept="video/*" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePackingVideoUpload(order.id, f); }}
                disabled={!!uploadingVideo || !!analyzingVideo} />
              <div className="flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-primary/10 text-primary text-xs font-semibold hover:bg-primary/20 transition-colors">
                <Upload className="w-4 h-4" /> {status === 'rejected' ? 'Renvoyer une vidéo' : 'Réessayer'}
              </div>
            </label>
          </div>
        )}
      </div>
    );
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

      <Tabs value={sellerTab} onValueChange={(value) => setSellerTab(value as 'products' | 'orders')}>
        <TabsList className="w-full">
          <TabsTrigger value="products" className="flex-1 gap-1.5 text-xs">
            <Package className="w-3.5 h-3.5" />
            Produits
          </TabsTrigger>
          <TabsTrigger value="orders" className="flex-1 gap-1.5 text-xs">
            <Truck className="w-3.5 h-3.5" />
            Commandes {paidOrders.length > 0 ? `(${paidOrders.length})` : ''}
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

                    {/* Packing video for orders >= 100€ */}
                    {renderPackingVideoSection(order)}

                    {/* Actions - block label if video not verified for orders >= 100€ */}
                    {(order.status === 'paid' || (order.status === 'shipped' && !order.shipping_label_url)) && (
                      needsPackingVideo(order) ? (
                        <p className="text-[11px] text-muted-foreground text-center py-1">⚠️ Vidéo d'emballage requise avant de générer l'étiquette</p>
                      ) : (
                        <Button size="sm" className="w-full" onClick={() => openLabelEditor(order)}
                          disabled={creatingLabel && shippingOrderId === order.id}>
                          {creatingLabel && shippingOrderId === order.id ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : (<Truck className="w-4 h-4 mr-2" />)}
                          {order.status === 'shipped' ? "Régénérer l'étiquette" : "Créer étiquette Mondial Relay"}
                        </Button>
                      )
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

                    {order.status === 'shipped' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full border-green-500/30 text-green-600 hover:bg-green-500/10"
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
      </Tabs>

      <Dialog open={labelEditorOpen} onOpenChange={setLabelEditorOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Édition étiquette Mondial Relay</DialogTitle>
            <DialogDescription>
              Renseigne le colis avant génération de l'étiquette pour {selectedOrder?.order_number || 'la commande'}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="weight">Poids (g)</Label>
                <Input id="weight" type="number" min={100} value={labelForm.weightGrams} onChange={(e) => setLabelForm((prev) => ({ ...prev, weightGrams: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="parcels">Nb colis</Label>
                <Input id="parcels" type="number" min={1} value={labelForm.parcels} onChange={(e) => setLabelForm((prev) => ({ ...prev, parcels: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="length">Longueur (cm)</Label>
                <Input id="length" type="number" min={1} value={labelForm.lengthCm} onChange={(e) => setLabelForm((prev) => ({ ...prev, lengthCm: e.target.value }))} placeholder="Optionnel" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="size">Code taille</Label>
                <Input id="size" value={labelForm.sizeCode} onChange={(e) => setLabelForm((prev) => ({ ...prev, sizeCode: e.target.value }))} placeholder="S, M, L... (optionnel)" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5 col-span-2">
                <Label htmlFor="sender-name">Expéditeur</Label>
                <Input id="sender-name" value={labelForm.senderName} onChange={(e) => setLabelForm((prev) => ({ ...prev, senderName: e.target.value }))} />
              </div>
              <div className="space-y-1.5 col-span-2">
                <Label htmlFor="sender-address">Adresse expéditeur</Label>
                <Input id="sender-address" value={labelForm.senderAddress} onChange={(e) => setLabelForm((prev) => ({ ...prev, senderAddress: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sender-postcode">Code postal</Label>
                <Input id="sender-postcode" value={labelForm.senderPostcode} onChange={(e) => setLabelForm((prev) => ({ ...prev, senderPostcode: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sender-city">Ville</Label>
                <Input id="sender-city" value={labelForm.senderCity} onChange={(e) => setLabelForm((prev) => ({ ...prev, senderCity: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sender-country">Pays (code)</Label>
                <Input id="sender-country" value={labelForm.senderCountry} onChange={(e) => setLabelForm((prev) => ({ ...prev, senderCountry: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sender-phone">Téléphone</Label>
                <Input id="sender-phone" value={labelForm.senderPhone} onChange={(e) => setLabelForm((prev) => ({ ...prev, senderPhone: e.target.value }))} />
              </div>
              <div className="space-y-1.5 col-span-2">
                <Label htmlFor="sender-email">Email</Label>
                <Input id="sender-email" type="email" value={labelForm.senderEmail} onChange={(e) => setLabelForm((prev) => ({ ...prev, senderEmail: e.target.value }))} />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setLabelEditorOpen(false)} disabled={creatingLabel}>
              Annuler
            </Button>
            <Button onClick={submitLabelCreation} disabled={!selectedOrder || creatingLabel}>
              {creatingLabel ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Truck className="w-4 h-4 mr-2" />}
              Générer l'étiquette
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
