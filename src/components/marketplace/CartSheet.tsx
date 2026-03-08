import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ShoppingCart, Plus, Minus, Trash2, CreditCard, Loader2, ShieldCheck, MapPin, ChevronDown, ChevronUp } from 'lucide-react';
import { useCart, useUpdateCartItem, useRemoveFromCart } from '@/hooks/useMarketplace';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { RelayPointPicker } from './RelayPointPicker';

interface SelectedRelay {
  id: string;
  name: string;
  address: string;
  postcode: string;
  city: string;
  country: string;
}

const estimateRelayShipping = (weightGrams: number, parcels: number) => {
  const basePerParcel = 4.2;
  const weightExtra =
    weightGrams <= 500 ? 0 :
    weightGrams <= 1000 ? 0.8 :
    weightGrams <= 2000 ? 1.6 :
    weightGrams <= 5000 ? 2.8 : 4.5;

  return Math.round((basePerParcel + weightExtra) * parcels * 100) / 100;
};

export function CartSheet() {
  const { data: cart = [] } = useCart();
  const updateItem = useUpdateCartItem();
  const removeItem = useRemoveFromCart();
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [selectedRelay, setSelectedRelay] = useState<SelectedRelay | null>(null);
  const [showRelayPicker, setShowRelayPicker] = useState(false);
  const FLAT_SHIPPING_ESTIMATE = 4.90;

  // Check if cart has physical products
  const hasPhysical = cart.some((item) => item.products?.product_type === 'physical');

  const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = cart.reduce((sum, item) => {
    const price = item.products?.price ?? 0;
    return sum + price * item.quantity;
  }, 0);
  const buyerFee = Math.round(subtotal * 0.05 * 100) / 100;

  const weightGrams = Math.max(100, Number(packageWeight) || 500);
  const parcelsCount = Math.max(1, Number(packageParcels) || 1);
  const shippingEstimate = hasPhysical && selectedRelay
    ? estimateRelayShipping(weightGrams, parcelsCount)
    : 0;
  const checkoutBlockedByRelay = hasPhysical && !selectedRelay;

  const total = subtotal + buyerFee + shippingEstimate;

  useEffect(() => {
    if (!selectedRelay) return;
    requestAnimationFrame(() => {
      packageSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }, [selectedRelay]);

  const handleCheckout = async (testMode = false) => {
    if (cart.length === 0) return;
    if (hasPhysical && !selectedRelay) {
      toast.error('Veuillez choisir un point relais pour la livraison');
      setShowRelayPicker(true);
      return;
    }

    setIsCheckingOut(true);

    try {
      const items = cart.map((item) => ({
        product_id: item.product_id,
        title: item.products?.title || 'Produit',
        price: item.products?.price || 0,
        quantity: item.quantity,
        seller_id: item.products?.seller_id || '',
        thumbnail_url: item.products?.thumbnail_url || null,
      }));

      const relayData = selectedRelay ? {
        id: selectedRelay.id,
        name: selectedRelay.name,
        address: selectedRelay.address,
        postcode: selectedRelay.postcode,
        city: selectedRelay.city,
        country: selectedRelay.country,
      } : null;

      const packageData = hasPhysical && selectedRelay
        ? {
            weight_grams: weightGrams,
            parcels: parcelsCount,
            shipping_estimate: shippingEstimate,
          }
        : null;

      if (testMode) {
        const { data, error } = await supabase.functions.invoke('marketplace-checkout', {
          body: { action: 'test_checkout', items, relay: relayData, package: packageData },
        });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        toast.success(`🎉 Commande test créée ! ${data.orderNumber}`);
        window.location.href = `/marketplace?order_success=${data.orderId}`;
        return;
      }

      const { data, error } = await supabase.functions.invoke('marketplace-checkout', {
        body: { action: 'create_checkout', items, relay: relayData, package: packageData },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      if (data?.url) {
        window.location.href = data.url;
      }
    } catch (e: any) {
      toast.error(e.message || 'Erreur lors du paiement');
    } finally {
      setIsCheckingOut(false);
    }
  };

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <ShoppingCart className="w-5 h-5" />
          {totalItems > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-[18px] h-[18px] rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center ring-2 ring-background">
              {totalItems > 9 ? '9+' : totalItems}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent className="flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ShoppingCart className="w-5 h-5" />
            Panier ({totalItems})
          </SheetTitle>
        </SheetHeader>

        {cart.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-muted-foreground text-sm">Votre panier est vide</p>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto space-y-3 py-4">
              {cart.map((item) => {
                const product = item.products;
                if (!product) return null;
                const thumb = product.thumbnail_url || product.images?.[0] || '/placeholder.svg';

                return (
                  <div key={item.id} className="flex gap-3 p-2 rounded-xl bg-secondary/40">
                    <img src={thumb} alt={product.title} className="w-16 h-16 rounded-lg object-cover flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-medium line-clamp-1">{product.title}</h4>
                      <p className="text-sm font-bold text-foreground mt-0.5">{product.price.toFixed(2)}€</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-6 w-6 rounded-full"
                          onClick={() => updateItem.mutate({ id: item.id, quantity: item.quantity - 1 })}
                        >
                          <Minus className="w-3 h-3" />
                        </Button>
                        <span className="text-sm font-medium w-6 text-center">{item.quantity}</span>
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-6 w-6 rounded-full"
                          onClick={() => updateItem.mutate({ id: item.id, quantity: item.quantity + 1 })}
                        >
                          <Plus className="w-3 h-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 ml-auto text-destructive hover:text-destructive"
                          onClick={() => removeItem.mutate(item.id)}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Relay point selection for physical products */}
              {hasPhysical && (
                <div className="space-y-2">
                  <Separator />
                  <button
                    onClick={() => setShowRelayPicker(!showRelayPicker)}
                    className="flex items-center justify-between w-full px-2 py-2 text-sm font-medium"
                  >
                    <span className="flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-primary" />
                      {selectedRelay ? 'Point relais sélectionné' : 'Choisir un point relais'}
                    </span>
                    {showRelayPicker ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>

                  {selectedRelay && !showRelayPicker && (
                    <div className="px-2 py-2 rounded-lg bg-primary/5 border border-primary/20 text-xs">
                      <p className="font-semibold">{selectedRelay.name}</p>
                      <p className="text-muted-foreground">{selectedRelay.address}</p>
                      <p className="text-muted-foreground">{selectedRelay.postcode} {selectedRelay.city}</p>
                    </div>
                  )}

                  {showRelayPicker && (
                    <RelayPointPicker
                      selectedId={selectedRelay?.id}
                      onSelect={(point) => {
                        setSelectedRelay({
                          id: point.id,
                          name: point.name,
                          address: point.address,
                          postcode: point.postcode,
                          city: point.city,
                          country: point.country,
                        });
                        setShowRelayPicker(false);
                      }}
                    />
                  )}

                  <div ref={packageSectionRef} className="rounded-lg border border-border/60 bg-card/60 p-3 space-y-2">
                    <p className="text-xs font-medium">Détails colis pour estimation</p>
                    {!selectedRelay ? (
                      <p className="text-[11px] text-muted-foreground">
                        Sélectionne d’abord un point relais pour afficher l’édition du poids et des colis.
                      </p>
                    ) : (
                      <>
                        <div className="grid grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <p className="text-[11px] text-muted-foreground">Poids (g)</p>
                            <Input
                              type="number"
                              min={100}
                              value={packageWeight}
                              onChange={(e) => setPackageWeight(e.target.value)}
                              className="h-8 text-xs"
                            />
                          </div>
                          <div className="space-y-1">
                            <p className="text-[11px] text-muted-foreground">Nombre de colis</p>
                            <Input
                              type="number"
                              min={1}
                              value={packageParcels}
                              onChange={(e) => setPackageParcels(e.target.value)}
                              className="h-8 text-xs"
                            />
                          </div>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          Estimation livraison Mondial Relay : <span className="font-semibold text-foreground">{shippingEstimate.toFixed(2)}€</span>
                        </p>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-3 pt-2">
              <Separator />
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Sous-total</span>
                  <span>{subtotal.toFixed(2)}€</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Frais de service (5%)</span>
                  <span>{buyerFee.toFixed(2)}€</span>
                </div>
                {hasPhysical && selectedRelay && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Livraison estimée</span>
                    <span>{shippingEstimate.toFixed(2)}€</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-base pt-1">
                  <span>Total</span>
                  <span>{total.toFixed(2)}€</span>
                </div>
              </div>
              <Button
                className="w-full premium-button"
                onClick={() => handleCheckout(false)}
                disabled={isCheckingOut || cart.length === 0 || checkoutBlockedByRelay}
              >
                {isCheckingOut ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <CreditCard className="w-4 h-4 mr-2" />
                )}
                {checkoutBlockedByRelay ? 'Choisir un point relais pour continuer' : isCheckingOut ? 'Redirection...' : `Payer ${total.toFixed(2)}€`}
              </Button>
              <Button
                variant="outline"
                className="w-full text-xs"
                onClick={() => handleCheckout(true)}
                disabled={isCheckingOut || cart.length === 0 || checkoutBlockedByRelay}
              >
                🧪 Commande test (sans paiement)
              </Button>
              <p className="text-[10px] text-muted-foreground text-center flex items-center justify-center gap-1">
                <ShieldCheck className="w-3 h-3" />
                Paiement sécurisé par Stripe · Livraison Mondial Relay
              </p>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
