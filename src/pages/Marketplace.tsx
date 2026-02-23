import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { useProducts } from '@/hooks/useMarketplace';
import { ProductCard } from '@/components/marketplace/ProductCard';
import { CartSheet } from '@/components/marketplace/CartSheet';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Search, Store, Plus } from 'lucide-react';
import { SellerDashboard } from '@/components/marketplace/SellerDashboard';
import { SEOHead } from '@/components/SEOHead';
import { CreateProductDialog } from '@/components/marketplace/CreateProductDialog';
import { useSellerProfile } from '@/hooks/useMarketplace';

const CATEGORIES = [
  { value: 'all', label: 'Tout' },
  { value: 'fashion', label: 'Mode' },
  { value: 'electronics', label: 'Tech' },
  { value: 'art', label: 'Art' },
  { value: 'beauty', label: 'Beauté' },
  { value: 'home', label: 'Maison' },
  { value: 'sports', label: 'Sport' },
  { value: 'digital', label: 'Digital' },
  { value: 'services', label: 'Services' },
];

export default function Marketplace() {
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') || 'browse');
  const { data: products = [], isLoading } = useProducts(category, search);
  const { data: seller } = useSellerProfile();

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab === 'seller') setActiveTab('seller');
  }, [searchParams]);

  return (
    <AppLayout fullWidth>
      <SEOHead title="Marketplace - ForSure" description="Achetez et vendez sur ForSure" />
      <div className="py-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold font-display">Marketplace</h1>
          <CartSheet />
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="w-full">
            <TabsTrigger value="browse" className="flex-1">Explorer</TabsTrigger>
            <TabsTrigger value="seller" className="flex-1">
              <Store className="w-4 h-4 mr-1" />
              Ma boutique
            </TabsTrigger>
          </TabsList>

          <TabsContent value="browse" className="space-y-4 mt-4">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Rechercher un produit..."
                className="pl-10 premium-input"
              />
            </div>

            {/* Categories */}
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
              {CATEGORIES.map((cat) => (
                <Button
                  key={cat.value}
                  variant={category === cat.value ? 'default' : 'outline'}
                  size="sm"
                  className="rounded-full flex-shrink-0 text-xs"
                  onClick={() => setCategory(cat.value)}
                >
                  {cat.label}
                </Button>
              ))}
            </div>

            {/* Products grid */}
            {isLoading ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="skeleton aspect-[3/4] rounded-2xl" />
                ))}
              </div>
            ) : products.length === 0 ? (
              <div className="text-center py-16">
                <Store className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
                <h3 className="font-semibold text-lg">Aucun produit trouvé</h3>
                <p className="text-muted-foreground text-sm mt-1">
                  {search ? 'Essayez un autre terme de recherche' : 'Soyez le premier à vendre !'}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {products.map((product) => (
                  <ProductCard key={product.id} product={product} />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="seller" className="mt-4">
            <SellerDashboard />
          </TabsContent>
        </Tabs>
      </div>

      {/* Floating add product button on mobile */}
      {seller && (
        <CreateProductDialog
          sellerId={seller.id}
          trigger={
            <Button
              size="icon"
              className="fixed bottom-20 right-4 z-50 md:hidden h-14 w-14 rounded-full shadow-lg premium-button"
            >
              <Plus className="w-6 h-6" />
            </Button>
          }
        />
      )}
    </AppLayout>
  );
}
