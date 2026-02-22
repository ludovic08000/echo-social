import { useParams, Link } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { useProduct, useAddToCart } from '@/hooks/useMarketplace';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ShoppingCart, BadgeCheck, Star, ArrowLeft, Package, Zap, Wrench } from 'lucide-react';
import { SEOHead } from '@/components/SEOHead';

const TYPE_LABELS: Record<string, { label: string; icon: any }> = {
  physical: { label: 'Produit physique', icon: Package },
  digital: { label: 'Produit numérique', icon: Zap },
  service: { label: 'Service', icon: Wrench },
};

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: product, isLoading } = useProduct(id);
  const addToCart = useAddToCart();

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

  return (
    <AppLayout>
      <SEOHead title={`${product.title} - Marketplace`} description={product.description || product.title} />
      <div className="py-4 space-y-4">
        {/* Back */}
        <Link to="/marketplace" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Marketplace
        </Link>

        {/* Image */}
        <div className="aspect-square rounded-2xl overflow-hidden bg-muted">
          <img src={images[0]} alt={product.title} className="w-full h-full object-cover" />
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

          {product.stock_quantity !== null && (
            <p className="text-sm text-muted-foreground">
              {product.stock_quantity > 0 ? `${product.stock_quantity} en stock` : 'Rupture de stock'}
            </p>
          )}

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
                <img src={seller.store_logo_url} alt={seller.store_name} className="w-10 h-10 rounded-full object-cover" />
              ) : (
                <div className="w-10 h-10 rounded-full bg-premium-gradient flex items-center justify-center">
                  <Store className="w-5 h-5 text-primary-foreground" />
                </div>
              )}
              <div className="flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-sm">{seller.store_name}</span>
                  {seller.is_verified && <BadgeCheck className="w-4 h-4 text-primary" />}
                </div>
                <p className="text-xs text-muted-foreground">{seller.total_sales} ventes</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}

function Store(props: any) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7" /><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" /><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4" /><path d="M2 7h20" /><path d="M22 7v3a2 2 0 0 1-2 2a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7" />
    </svg>
  );
}
