import { Link } from 'react-router-dom';
import { Heart, BadgeCheck, Star, Eye, Package } from 'lucide-react';
import { useAddToCart } from '@/hooks/useMarketplace';
import { useProductFavorites, useToggleFavorite } from '@/hooks/useProductFavorites';
import { cn } from '@/lib/utils';

const CONDITION_LABELS: Record<string, string> = {
  new: 'Neuf',
  like_new: 'Comme neuf',
  very_good: 'Très bon état',
  good: 'Bon état',
  fair: 'État correct',
  for_parts: 'Pour pièces',
};

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
    <div className="group relative">
      {/* Image */}
      <Link to={`/marketplace/product/${product.id}`} className={cn(
        "block relative overflow-hidden bg-muted",
        compact ? "aspect-square rounded-xl" : "aspect-[3/4] rounded-2xl"
      )}>
        <img
          src={thumbnail}
          alt={product.title}
          className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
          loading="lazy"
        />
        
        {/* Gradient overlay bottom */}
        <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

        {/* Badges top-left */}
        <div className="absolute top-2 left-2 flex flex-col gap-1">
          {hasDiscount && (
            <span className="bg-destructive text-destructive-foreground text-[10px] font-bold px-2 py-0.5 rounded-lg shadow-sm">
              -{discountPercent}%
            </span>
          )}
          {product.condition && (
            <span className="bg-background/80 backdrop-blur-sm text-foreground text-[9px] font-semibold px-2 py-0.5 rounded-lg">
              {CONDITION_LABELS[product.condition] || product.condition}
            </span>
          )}
        </div>

        {/* View count bottom-left on hover */}
        {product.view_count > 0 && (
          <div className="absolute bottom-2 left-2 flex items-center gap-1 text-[10px] text-white/90 font-medium opacity-0 group-hover:opacity-100 transition-opacity">
            <Eye className="w-3 h-3" />
            {product.view_count}
          </div>
        )}
      </Link>

      {/* Favorite button */}
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleFav.mutate(product.id);
        }}
        className={cn(
          "absolute top-2 right-2 w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-200 active:scale-90",
          isFav 
            ? "bg-destructive/90 text-white shadow-[0_2px_8px_hsl(var(--destructive)/0.4)]"
            : "bg-background/70 backdrop-blur-sm text-foreground hover:bg-background/90"
        )}
      >
        <Heart className={cn("w-4 h-4", isFav && "fill-current")} />
      </button>

      {/* Info */}
      <div className="mt-2 px-0.5 space-y-1">
        <Link to={`/marketplace/product/${product.id}`}>
          <h3 className="text-[13px] font-semibold text-foreground line-clamp-1 group-hover:text-primary transition-colors leading-tight">
            {product.title}
          </h3>
        </Link>

        {/* Seller */}
        {!compact && seller && (
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {seller.is_verified && <BadgeCheck className="w-3 h-3 text-primary flex-shrink-0" />}
            <span className="truncate">{seller.store_name}</span>
          </div>
        )}

        {/* Rating */}
        {!compact && product.rating_count > 0 && (
          <div className="flex items-center gap-0.5 text-[11px]">
            {Array.from({ length: 5 }).map((_, i) => (
              <Star
                key={i}
                className={cn(
                  "w-3 h-3",
                  i < Math.round(product.rating_average || 0)
                    ? "fill-primary text-primary"
                    : "text-border"
                )}
              />
            ))}
            <span className="text-muted-foreground ml-0.5">({product.rating_count})</span>
          </div>
        )}

        {/* Price */}
        <div className="flex items-baseline gap-1.5">
          <span className={cn("font-bold text-foreground", compact ? "text-sm" : "text-[15px]")}>
            {product.price.toFixed(2)} €
          </span>
          {hasDiscount && !compact && (
            <span className="text-[11px] text-muted-foreground line-through">
              {product.compare_at_price.toFixed(2)} €
            </span>
          )}
        </div>

        {/* Weight info */}
        {!compact && product.weight_grams && (
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Package className="w-3 h-3" />
            <span>{product.weight_grams >= 1000 ? `${(product.weight_grams / 1000).toFixed(1)} kg` : `${product.weight_grams}g`}</span>
          </div>
        )}

        {/* Shipping info */}
        {!compact && product.shipping_type === 'free' && (
          <span className="text-[10px] font-medium text-primary bg-primary/8 px-1.5 py-0.5 rounded-md inline-block">
            Livraison gratuite
          </span>
        )}
      </div>
    </div>
  );
}
