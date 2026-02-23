import { useProducts } from '@/hooks/useMarketplace';
import { Link } from 'react-router-dom';
import { ShoppingBag, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ProductCard } from '@/components/marketplace/ProductCard';

export function FeedMarketplaceSection() {
  const { data: products = [] } = useProducts();
  const featured = products.slice(0, 4);

  if (featured.length === 0) return null;

  return (
    <div className="px-4 lg:px-0 py-2">
      <div className="premium-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <ShoppingBag className="w-4 h-4 text-primary" />
            </div>
            <h3 className="font-semibold text-sm">Marketplace</h3>
          </div>
          <Link to="/marketplace">
            <Button variant="ghost" size="sm" className="text-xs gap-1 text-muted-foreground">
              Tout voir <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {featured.map((product) => (
            <ProductCard key={product.id} product={product} compact />
          ))}
        </div>
      </div>
    </div>
  );
}
