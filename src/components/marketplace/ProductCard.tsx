import { Link } from 'react-router-dom';
import { ShoppingCart, Star, BadgeCheck, Heart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAddToCart } from '@/hooks/useMarketplace';
import { useProductFavorites, useToggleFavorite } from '@/hooks/useProductFavorites';
import { cn } from '@/lib/utils';

interface ProductCardProps {
  product: any;
  compact?: boolean;
}

export function ProductCard({ product, compact }: ProductCardProps) {
  const addToCart = useAddToCart();
  const { data: favorites = [] } = useProductFavorites();
  const toggleFav = useToggleFavorite();
  const seller = product.seller_profiles;
  const thumbnail = product.thumbnail_url || product.images?.[0] || '/placeholder.svg';
  const hasDiscount = product.compare_at_price && product.compare_at_price > product.price;
  const discountPercent = hasDiscount
    ? Math.round((1 - product.price / product.compare_at_price) * 100)
    : 0;
  const isFav = favorites.includes(product.id);

  return (
    <div className="premium-card group overflow-hidden">
      <Link to={`/marketplace/product/${product.id}`} className={cn("block relative overflow-hidden", compact ? "aspect-[4/3]" : "aspect-square")}>
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
          <span className="absolute top-2 right-10 bg-primary/90 text-primary-foreground text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase">
            {product.product_type === 'digital' ? 'Numérique' : 'Service'}
          </span>
        )}
        {/* Favorite button */}
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleFav.mutate(product.id);
          }}
          className="absolute top-2 right-2 w-7 h-7 rounded-full bg-background/70 backdrop-blur-sm flex items-center justify-center transition-colors hover:bg-background"
        >
          <Heart className={cn("w-3.5 h-3.5", isFav ? "fill-destructive text-destructive" : "text-foreground")} />
        </button>
      </Link>

      <div className={cn("space-y-1.5", compact ? "p-2" : "p-3 space-y-2")}>
        <Link to={`/marketplace/product/${product.id}`}>
          <h3 className={cn("font-semibold text-foreground line-clamp-2 group-hover:text-primary transition-colors", compact ? "text-xs" : "text-sm")}>
            {product.title}
          </h3>
        </Link>

        {!compact && seller && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {seller.is_verified && <BadgeCheck className="w-3.5 h-3.5 text-primary" />}
            <span className="truncate">{seller.store_name}</span>
          </div>
        )}

        {!compact && product.rating_count > 0 && (
          <div className="flex items-center gap-1 text-xs">
            <Star className="w-3.5 h-3.5 fill-primary text-primary" />
            <span className="font-medium text-foreground">{product.rating_average?.toFixed(1)}</span>
            <span className="text-muted-foreground">({product.rating_count})</span>
          </div>
        )}

        <div className="flex items-center justify-between pt-0.5">
          <div className="flex items-baseline gap-1.5">
            <span className={cn("font-bold text-foreground", compact ? "text-sm" : "text-lg")}>{product.price.toFixed(2)}€</span>
            {hasDiscount && !compact && (
              <span className="text-xs text-muted-foreground line-through">{product.compare_at_price.toFixed(2)}€</span>
            )}
          </div>
          {!compact && (
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
          )}
        </div>
      </div>
    </div>
  );
}
