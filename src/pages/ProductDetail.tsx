import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { useProduct, useAddToCart } from '@/hooks/useMarketplace';
import { useProductFavorites, useToggleFavorite } from '@/hooks/useProductFavorites';
import { ProductReviews } from '@/components/marketplace/ProductReviews';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ShoppingCart, BadgeCheck, Star, ArrowLeft, Package, Zap, Wrench, Heart, Store, ChevronLeft, ChevronRight, Truck, MapPin, Download } from 'lucide-react';
import { SEOHead } from '@/components/SEOHead';
import { cn } from '@/lib/utils';

const TYPE_LABELS: Record<string, { label: string; icon: any }> = {
  physical: { label: 'Produit physique', icon: Package },
  digital: { label: 'Produit numérique', icon: Zap },
  service: { label: 'Service', icon: Wrench },
};

const SHIPPING_LABELS: Record<string, { label: string; icon: any }> = {
  standard: { label: 'Standard (3-5j)', icon: Truck },
  express: { label: 'Express (1-2j)', icon: Truck },
  pickup: { label: 'Retrait en main propre', icon: MapPin },
  digital: { label: 'Livraison numérique', icon: Download },
  free: { label: 'Livraison gratuite', icon: Truck },
};

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: product, isLoading } = useProduct(id);
  const addToCart = useAddToCart();
  const { data: favorites = [] } = useProductFavorites();
  const toggleFav = useToggleFavorite();
  const [imgIndex, setImgIndex] = useState(0);

  if (isLoading) {
    return (
      <AppLayout>
        <div className="py-4 space-y-4">
          <div className="skeleton aspect-square rounded-2xl" />
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

  return (
    <AppLayout>
      <SEOHead title={`${product.title} - Marketplace`} description={product.description || product.title} />
      <div className="py-4 space-y-4">
        {/* Back */}
        <Link to="/marketplace" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Marketplace
        </Link>

        {/* Image gallery */}
        <div className="relative aspect-square rounded-2xl overflow-hidden bg-muted">
          <img src={images[imgIndex]} alt={product.title} className="w-full h-full object-cover" />
          {images.length > 1 && (
            <>
              <button
                onClick={() => setImgIndex((i) => (i - 1 + images.length) % images.length)}
                className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-background/70 backdrop-blur-sm flex items-center justify-center"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setImgIndex((i) => (i + 1) % images.length)}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-background/70 backdrop-blur-sm flex items-center justify-center"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
                {images.map((_: string, i: number) => (
                  <button
                    key={i}
                    onClick={() => setImgIndex(i)}
                    className={cn("w-2 h-2 rounded-full transition-colors", i === imgIndex ? "bg-primary" : "bg-background/60")}
                  />
                ))}
              </div>
            </>
          )}
          {/* Favorite */}
          <button
            onClick={() => toggleFav.mutate(product.id)}
            className="absolute top-3 right-3 w-10 h-10 rounded-full bg-background/70 backdrop-blur-sm flex items-center justify-center"
          >
            <Heart className={cn("w-5 h-5", isFav ? "fill-destructive text-destructive" : "text-foreground")} />
          </button>
        </div>

        {/* Info */}
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-2">
            <h1 className="text-xl font-bold">{product.title}</h1>
            <Badge variant="outline" className="flex-shrink-0 gap-1">
              <TypeIcon className="w-3 h-3" />
              {typeInfo.label}
            </Badge>
          </div>

          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-foreground">{product.price.toFixed(2)}€</span>
            {hasDiscount && (
              <span className="text-lg text-muted-foreground line-through">{product.compare_at_price!.toFixed(2)}€</span>
            )}
          </div>

          {product.rating_count > 0 && (
            <div className="flex items-center gap-1.5">
              <Star className="w-4 h-4 fill-primary text-primary" />
              <span className="font-medium">{product.rating_average?.toFixed(1)}</span>
              <span className="text-muted-foreground text-sm">({product.rating_count} avis)</span>
            </div>
          )}

          {/* Size & Color */}
          {(product.size || product.color) && (
            <div className="flex gap-2">
              {product.size && <Badge variant="secondary">Taille: {product.size}</Badge>}
              {product.color && <Badge variant="secondary">Couleur: {product.color}</Badge>}
            </div>
          )}

          {/* Stock */}
          {product.stock_quantity !== null && (
            <p className={cn("text-sm", product.stock_quantity > 0 ? "text-muted-foreground" : "text-destructive font-medium")}>
              {product.stock_quantity > 0 ? `${product.stock_quantity} en stock` : 'Rupture de stock'}
            </p>
          )}

          {/* Shipping info */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShippingIcon className="w-4 h-4" />
            <span>{shippingInfo.label}</span>
            {product.shipping_price > 0 && <span className="font-medium text-foreground">+{product.shipping_price.toFixed(2)}€</span>}
          </div>

          <Button
            className="w-full premium-button"
            onClick={() => addToCart.mutate({ productId: product.id })}
            disabled={addToCart.isPending || (product.stock_quantity !== null && product.stock_quantity <= 0)}
          >
            <ShoppingCart className="w-4 h-4 mr-2" />
            Ajouter au panier
          </Button>
        </div>

        <Separator />

        {/* Description */}
        {product.description && (
          <div>
            <h2 className="font-semibold mb-2">Description</h2>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{product.description}</p>
          </div>
        )}

        <Separator />

        {/* Seller info */}
        {seller && (
          <div className="premium-card p-4">
            <div className="flex items-center gap-3">
              {seller.store_logo_url ? (
                <img src={seller.store_logo_url} alt={seller.store_name} className="w-12 h-12 rounded-full object-cover" />
              ) : (
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <Store className="w-6 h-6 text-primary" />
                </div>
              )}
              <div className="flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold">{seller.store_name}</span>
                  {seller.is_verified && <BadgeCheck className="w-4 h-4 text-primary" />}
                </div>
                {seller.store_description && (
                  <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{seller.store_description}</p>
                )}
                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                  <span>{seller.total_sales} ventes</span>
                  {seller.rating_average && (
                    <span className="flex items-center gap-0.5">
                      <Star className="w-3 h-3 fill-primary text-primary" />
                      {seller.rating_average.toFixed(1)} ({seller.rating_count})
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        <Separator />

        {/* Reviews */}
        <ProductReviews productId={product.id} />
      </div>
    </AppLayout>
  );
}
