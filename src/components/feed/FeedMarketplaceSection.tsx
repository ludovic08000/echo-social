import { useProducts } from '@/hooks/useMarketplace';
import { Link } from 'react-router-dom';
import { ShoppingBag } from 'lucide-react';
import { ProductCard } from '@/components/marketplace/ProductCard';
import { rotateMarketplaceProducts } from '@/lib/ml/feedAlgorithm';
import { useMemo } from 'react';
import { useIsMarketplaceEnabled } from '@/hooks/usePlatformStats';

export function FeedMarketplaceSection() {
  const { enabled } = useIsMarketplaceEnabled();
  const { data: products = [] } = useProducts(undefined, undefined, undefined, 12);

  const featured = useMemo(() => {
    if (!enabled) return [];
    const rotated = rotateMarketplaceProducts(products as any);
    return rotated.slice(0, 6);
  }, [products, enabled]);

  if (!enabled || featured.length === 0) return null;

  return (
    <article className="bg-card border border-border/20 rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
            <ShoppingBag className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Marketplace</h3>
            <p className="text-[10px] text-muted-foreground">Découvrez les dernières annonces</p>
          </div>
        </div>
        <Link to="/marketplace" className="text-xs text-primary font-medium hover:text-primary/80 transition-colors">
          Voir tout
        </Link>
      </div>
      
      <div className="px-4 pb-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {featured.map((product: any) => (
            <ProductCard key={product.id} product={product} compact />
          ))}
        </div>
      </div>
    </article>
  );
}
