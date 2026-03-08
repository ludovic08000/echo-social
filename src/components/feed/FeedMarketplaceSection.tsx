import { useProducts } from '@/hooks/useMarketplace';
import { Link } from 'react-router-dom';
import { ShoppingBag, ArrowRight, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ProductCard } from '@/components/marketplace/ProductCard';
import { rotateMarketplaceProducts } from '@/lib/feedAlgorithm';
import { useMemo } from 'react';

export function FeedMarketplaceSection() {
  const { data: products = [] } = useProducts();
  
  // Fair rotation: different sellers get exposure at different times
  const featured = useMemo(() => {
    const rotated = rotateMarketplaceProducts(products as any);
    return rotated.slice(0, 6);
  }, [products]);

  if (featured.length === 0) return null;

  return (
    <div className="px-4 lg:px-0 py-2">
      <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/5 via-background to-accent/5 p-4 space-y-3 shadow-lg shadow-primary/5">
        {/* Decorative glow */}
        <div className="absolute -top-12 -right-12 w-32 h-32 bg-primary/10 rounded-full blur-3xl pointer-events-none" />
        
        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-md shadow-primary/20">
              <ShoppingBag className="w-4.5 h-4.5 text-primary-foreground" />
            </div>
            <div>
              <h3 className="font-bold text-sm flex items-center gap-1.5">
                Marketplace
                <Sparkles className="w-3.5 h-3.5 text-primary animate-pulse" />
              </h3>
              <p className="text-[11px] text-muted-foreground">Découvrez les dernières annonces</p>
            </div>
          </div>
          <Link to="/marketplace">
            <Button size="sm" className="text-xs gap-1 rounded-full px-4 bg-primary/10 text-primary hover:bg-primary/20 border-0">
              Tout voir <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          </Link>
        </div>
        
        <div className="relative grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {featured.map((product: any) => (
            <ProductCard key={product.id} product={product} compact />
          ))}
        </div>
      </div>
    </div>
  );
}
