import { Link } from 'react-router-dom';
import { ShoppingCart, Star, BadgeCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAddToCart } from '@/hooks/useMarketplace';

interface ProductCardProps {
  product: any;
}

export function ProductCard({ product }: ProductCardProps) {
  const addToCart = useAddToCart();
  const seller = product.seller_profiles;
  const thumbnail = product.thumbnail_url || product.images?.[0] || '/placeholder.svg';
  const hasDiscount = product.compare_at_price && product.compare_at_price > product.price;
  const discountPercent = hasDiscount
    ? Math.round((1 - product.price / product.compare_at_price) * 100)
    : 0;

  return (
    <div className="premium-card group overflow-hidden">
      <Link to={`/marketplace/product/${product.id}`} className="block relative aspect-square overflow-hidden">
        <img
          src={thumbnail}
          alt={product.title}
          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
          loading="lazy"
        />
        {hasDiscount && (
          <span className="absolute top-2 left-2 bg-destructive text-destructive-foreground text-xs font-bold px-2 py-0.5 rounded-full">
            -{discountPercent}%
          </span>
        )}
        {product.product_type !== 'physical' && (
          <span className="absolute top-2 right-2 bg-primary/90 text-primary-foreground text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase">
            {product.product_type === 'digital' ? 'Numérique' : 'Service'}
          </span>
        )}
      </Link>

      <div className="p-3 space-y-2">
        <Link to={`/marketplace/product/${product.id}`}>
          <h3 className="font-semibold text-sm text-foreground line-clamp-2 group-hover:text-primary transition-colors">
            {product.title}
          </h3>
        </Link>

        {seller && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {seller.is_verified && <BadgeCheck className="w-3.5 h-3.5 text-primary" />}
            <span className="truncate">{seller.store_name}</span>
          </div>
        )}

        {product.rating_count > 0 && (
          <div className="flex items-center gap-1 text-xs">
            <Star className="w-3.5 h-3.5 fill-primary text-primary" />
            <span className="font-medium text-foreground">{product.rating_average?.toFixed(1)}</span>
            <span className="text-muted-foreground">({product.rating_count})</span>
          </div>
        )}

        <div className="flex items-center justify-between pt-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-bold text-foreground">{product.price.toFixed(2)}€</span>
            {hasDiscount && (
              <span className="text-xs text-muted-foreground line-through">{product.compare_at_price.toFixed(2)}€</span>
            )}
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 rounded-full hover:bg-primary/10 hover:text-primary"
            onClick={(e) => {
              e.preventDefault();
              addToCart.mutate({ productId: product.id });
            }}
            disabled={addToCart.isPending}
          >
            <ShoppingCart className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
