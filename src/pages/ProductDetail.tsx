import { useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { useProduct, useAddToCart, useCart } from '@/hooks/useMarketplace';
import { useAuth } from '@/lib/auth';
import { useProductFavorites, useToggleFavorite } from '@/hooks/useProductFavorites';
import { ProductReviews } from '@/components/marketplace/ProductReviews';
import { useChatWidget } from '@/components/ChatWidgetContext';
import { useCreateConversation } from '@/hooks/useMessages';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ShoppingCart, BadgeCheck, Star, ArrowLeft, Package, Zap, Wrench, Heart, Store, ChevronLeft, ChevronRight, Truck, MapPin, Download, Shield, MessageCircle, Share2, Tag } from 'lucide-react';
import { SEOHead } from '@/components/SEOHead';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const TYPE_LABELS: Record<string, { label: string; icon: any }> = {
  physical: { label: 'Physique', icon: Package },
  digital: { label: 'Numérique', icon: Zap },
  service: { label: 'Service', icon: Wrench },
};

const SHIPPING_LABELS: Record<string, { label: string; icon: any }> = {
  standard: { label: 'Standard (3-5j)', icon: Truck },
  express: { label: 'Express (1-2j)', icon: Truck },
  pickup: { label: 'Retrait', icon: MapPin },
  digital: { label: 'Téléchargement', icon: Download },
  free: { label: 'Gratuit', icon: Truck },
};

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: product, isLoading } = useProduct(id);
  const { user } = useAuth();
  const addToCart = useAddToCart();
  const { data: cart = [] } = useCart();
  const { data: favorites = [] } = useProductFavorites();
  const toggleFav = useToggleFavorite();
  const [imgIndex, setImgIndex] = useState(0);
  const { openNegotiation } = useChatWidget();
  const createConversation = useCreateConversation();
  const [negLoading, setNegLoading] = useState(false);

  const handleOpenNegotiation = useCallback(async () => {
    if (!product || !user) return;
    const seller = product.seller_profiles;
    const sellerUserId = (seller as any)?.user_id;
    if (!sellerUserId) { toast.error('Vendeur introuvable'); return; }
    if (sellerUserId === user.id) { toast.error('Vous ne pouvez pas négocier votre propre produit'); return; }
    
    setNegLoading(true);
    try {
      const conv = await createConversation.mutateAsync(sellerUserId);
      openNegotiation(product as any, conv.id);
    } catch {
      toast.error('Erreur ouverture conversation');
    } finally {
      setNegLoading(false);
    }
  }, [product, user, createConversation, openNegotiation]);

  if (isLoading) {
    return (
      <AppLayout>
        <div className="py-4 space-y-4">
          <div className="skeleton aspect-[4/5] rounded-2xl" />
          <div className="skeleton h-8 w-2/3" />
          <div className="skeleton h-6 w-1/3" />
        </div>
      </AppLayout>
    );
  }

  if (!product) {
    return (
      <AppLayout>
        <div className="py-16 text-center">
          <p className="text-muted-foreground">Produit introuvable</p>
          <Link to="/marketplace"><Button variant="outline" className="mt-4">Retour</Button></Link>
        </div>
      </AppLayout>
    );
  }

  const seller = product.seller_profiles;
  const images = product.images?.length ? product.images : [product.thumbnail_url || '/placeholder.svg'];
  const typeInfo = TYPE_LABELS[product.product_type] || TYPE_LABELS.physical;
  const TypeIcon = typeInfo.icon;
  const hasDiscount = product.compare_at_price && product.compare_at_price > product.price;
  const isFav = favorites.includes(product.id);
  const shippingInfo = SHIPPING_LABELS[product.shipping_type] || SHIPPING_LABELS.standard;
  const ShippingIcon = shippingInfo.icon;
  const isOutOfStock = product.stock_quantity !== null && product.stock_quantity <= 0;
  const isOwnProduct = user && seller && (seller as any).user_id === user.id;

  return (
    <AppLayout>
      <SEOHead title={`${product.title} - Marketplace`} description={product.description || product.title} />
      <div className="pb-28 space-y-4">
        {/* Back + actions bar */}
        <div className="flex items-center justify-between py-2">
          <Link to="/marketplace" className="w-9 h-9 rounded-xl bg-secondary/60 flex items-center justify-center hover:bg-secondary transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="flex gap-2">
            <button className="w-9 h-9 rounded-xl bg-secondary/60 flex items-center justify-center hover:bg-secondary transition-colors">
              <Share2 className="w-4 h-4" />
            </button>
            <button
              onClick={() => toggleFav.mutate(product.id)}
              className={cn(
                "w-9 h-9 rounded-xl flex items-center justify-center transition-all",
                isFav ? "bg-destructive/10 text-destructive" : "bg-secondary/60 hover:bg-secondary"
              )}
            >
              <Heart className={cn("w-4 h-4", isFav && "fill-current")} />
            </button>
          </div>
        </div>

        {/* Image gallery */}
        <div className="relative aspect-[4/5] rounded-3xl overflow-hidden bg-muted shadow-[var(--shadow-lg)]">
          <img src={images[imgIndex]} alt={product.title} className="w-full h-full object-cover" />
          
          {images.length > 1 && (
            <>
              <button
                onClick={() => setImgIndex((i) => (i - 1 + images.length) % images.length)}
                className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-xl bg-background/80 backdrop-blur-sm flex items-center justify-center shadow-md active:scale-90 transition-transform"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setImgIndex((i) => (i + 1) % images.length)}
                className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-xl bg-background/80 backdrop-blur-sm flex items-center justify-center shadow-md active:scale-90 transition-transform"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1.5 bg-background/60 backdrop-blur-sm rounded-full px-2 py-1">
                {images.map((_: string, i: number) => (
                  <button
                    key={i}
                    onClick={() => setImgIndex(i)}
                    className={cn("w-1.5 h-1.5 rounded-full transition-all", i === imgIndex ? "bg-primary w-4" : "bg-foreground/30")}
                  />
                ))}
              </div>
            </>
          )}

          <div className="absolute top-4 left-4 flex flex-col gap-1.5">
            {hasDiscount && (
              <span className="bg-destructive text-destructive-foreground text-xs font-bold px-2.5 py-1 rounded-xl shadow-md">
                -{Math.round((1 - product.price / product.compare_at_price!) * 100)}%
              </span>
            )}
            <Badge variant="secondary" className="gap-1 rounded-xl bg-background/80 backdrop-blur-sm shadow-sm">
              <TypeIcon className="w-3 h-3" />
              {typeInfo.label}
            </Badge>
          </div>
        </div>

        {images.length > 1 && (
          <div className="flex gap-2 overflow-x-auto scrollbar-none pb-1">
            {images.map((img: string, i: number) => (
              <button
                key={i}
                onClick={() => setImgIndex(i)}
                className={cn(
                  "w-16 h-16 rounded-xl overflow-hidden flex-shrink-0 border-2 transition-all",
                  i === imgIndex ? "border-primary shadow-[0_0_8px_hsl(var(--primary)/0.3)]" : "border-transparent opacity-60 hover:opacity-100"
                )}
              >
                <img src={img} alt="" className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        )}

        <div className="space-y-3">
          <h1 className="text-xl font-bold leading-tight">{product.title}</h1>
          <div className="flex items-baseline gap-2.5">
            <span className="text-3xl font-extrabold text-foreground tracking-tight">{product.price.toFixed(2)} €</span>
            {hasDiscount && (
              <span className="text-base text-muted-foreground line-through">{product.compare_at_price!.toFixed(2)} €</span>
            )}
          </div>
          {product.rating_count > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="flex">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star key={i} className={cn("w-4 h-4", i < Math.round(product.rating_average || 0) ? "fill-primary text-primary" : "text-border")} />
                ))}
              </div>
              <span className="text-sm font-medium">{product.rating_average?.toFixed(1)}</span>
              <span className="text-sm text-muted-foreground">({product.rating_count} avis)</span>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {product.size && <Badge variant="outline" className="rounded-xl text-xs">Taille: {product.size}</Badge>}
            {product.color && <Badge variant="outline" className="rounded-xl text-xs">Couleur: {product.color}</Badge>}
            {product.stock_quantity !== null && (
              <Badge variant={isOutOfStock ? "destructive" : "outline"} className="rounded-xl text-xs">
                {isOutOfStock ? 'Épuisé' : `${product.stock_quantity} en stock`}
              </Badge>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center gap-2 p-3 rounded-2xl bg-secondary/40 border border-border/30">
              <ShippingIcon className="w-5 h-5 text-primary flex-shrink-0" />
              <div>
                <p className="text-xs font-semibold">{shippingInfo.label}</p>
                <p className="text-[10px] text-muted-foreground">
                  {product.shipping_price > 0 ? `+${product.shipping_price.toFixed(2)} €` : 'Inclus'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 p-3 rounded-2xl bg-secondary/40 border border-border/30">
              <Shield className="w-5 h-5 text-primary flex-shrink-0" />
              <div>
                <p className="text-xs font-semibold">Protection</p>
                <p className="text-[10px] text-muted-foreground">Achat sécurisé</p>
              </div>
            </div>
          </div>
        </div>

        <Separator />

        {product.description && (
          <div>
            <h2 className="font-bold text-sm mb-2">Description</h2>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">{product.description}</p>
          </div>
        )}

        <Separator />

        {seller && (
          <div className="p-4 rounded-2xl bg-card border border-border/40 shadow-[var(--shadow-sm)]">
            <div className="flex items-center gap-3">
              {seller.store_logo_url ? (
                <img src={seller.store_logo_url} alt={seller.store_name} className="w-14 h-14 rounded-2xl object-cover" />
              ) : (
                <div className="w-14 h-14 rounded-2xl bg-[image:var(--premium-gradient)] flex items-center justify-center">
                  <Store className="w-7 h-7 text-primary-foreground" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-sm">{seller.store_name}</span>
                  {seller.is_verified && <BadgeCheck className="w-4 h-4 text-primary" />}
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                  <span className="font-medium">{seller.total_sales} ventes</span>
                  {seller.rating_average && (
                    <span className="flex items-center gap-0.5">
                      <Star className="w-3 h-3 fill-primary text-primary" />
                      {seller.rating_average.toFixed(1)}
                    </span>
                  )}
                </div>
              </div>
              <Button variant="outline" size="sm" className="rounded-xl text-xs gap-1"
                onClick={handleOpenNegotiation}
                disabled={negLoading}>
                <MessageCircle className="w-3.5 h-3.5" />
                Contact
              </Button>
            </div>
          </div>
        )}

        <Separator />

        <ProductReviews productId={product.id} />
      </div>

      {/* Fixed bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-card/95 backdrop-blur-2xl border-t border-border/30 safe-area-pb">
        <div className="flex items-center gap-3 px-4 py-3 max-w-2xl mx-auto">
          <div className="flex-1 min-w-0">
            <p className="text-lg font-extrabold tracking-tight">{product.price.toFixed(2)} €</p>
            {hasDiscount && <p className="text-[11px] text-muted-foreground line-through">{product.compare_at_price!.toFixed(2)} €</p>}
          </div>
          {!isOwnProduct && !isOutOfStock && (
            <Button
              variant="outline"
              className="h-12 rounded-2xl text-sm font-bold gap-1.5 border-primary/30"
              onClick={handleOpenNegotiation}
              disabled={negLoading}
            >
              <Tag className="w-4 h-4" />
              Négocier
            </Button>
          )}
          <Button
            className="premium-button flex-1 h-12 text-sm font-bold rounded-2xl"
            onClick={() => addToCart.mutate({ productId: product.id })}
            disabled={addToCart.isPending || isOutOfStock || !!isOwnProduct}
          >
            <ShoppingCart className="w-4 h-4 mr-2" />
            {isOwnProduct ? 'Votre produit' : isOutOfStock ? 'Épuisé' : 'Ajouter au panier'}
          </Button>
        </div>
      </div>
    </AppLayout>
  );
}
