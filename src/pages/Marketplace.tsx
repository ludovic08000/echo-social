import { useState, useEffect, useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { AppLayout } from '@/components/AppLayout';
import { useProducts, LocationFilter } from '@/hooks/useMarketplace';
import { ProductCard } from '@/components/marketplace/ProductCard';
import { CartSheet } from '@/components/marketplace/CartSheet';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Search, Store, Plus, ShoppingBag, Sparkles, Flame, Clock, SlidersHorizontal, X, Heart, TrendingUp, Tag, MapPin, Globe } from 'lucide-react';
import { SellerDashboard } from '@/components/marketplace/SellerDashboard';
import { SEOHead } from '@/components/SEOHead';
import { CreateProductDialog } from '@/components/marketplace/CreateProductDialog';
import { useSellerProfile } from '@/hooks/useMarketplace';
import { useProductFavorites } from '@/hooks/useProductFavorites';
import { cn } from '@/lib/utils';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { COUNTRIES, GEO_DATA } from '@/lib/geoData';

const CATEGORIES = [
  { value: 'all', label: 'Tout', icon: '🔥' },
  { value: 'fashion', label: 'Mode', icon: '👗' },
  { value: 'electronics', label: 'Tech', icon: '📱' },
  { value: 'art', label: 'Art', icon: '🎨' },
  { value: 'beauty', label: 'Beauté', icon: '💄' },
  { value: 'home', label: 'Maison', icon: '🏠' },
  { value: 'sports', label: 'Sport', icon: '⚽' },
  { value: 'digital', label: 'Digital', icon: '💻' },
  { value: 'services', label: 'Services', icon: '🔧' },
  { value: 'books', label: 'Livres', icon: '📚' },
];

const SORT_OPTIONS = [
  { value: 'recent', label: 'Récents', icon: Clock },
  { value: 'popular', label: 'Populaires', icon: Flame },
  { value: 'price-asc', label: 'Prix ↑', icon: TrendingUp },
  { value: 'price-desc', label: 'Prix ↓', icon: Tag },
];

const LOCATION_SCOPES = [
  { value: 'europe', label: 'Europe', icon: '🌍' },
  { value: 'country', label: 'Pays', icon: '🏳️' },
  { value: 'region', label: 'Région', icon: '📍' },
  { value: 'local', label: 'Ville', icon: '🏘️' },
];

export default function Marketplace() {
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') || 'browse');
  const [sortBy, setSortBy] = useState('recent');

  // Handle order success - verify payment
  useEffect(() => {
    const orderId = searchParams.get('order_success');
    if (orderId) {
      supabase.functions.invoke('marketplace-checkout', {
        body: { action: 'verify_payment', orderId },
      }).then(({ data }) => {
        if (data?.paid) {
          toast.success('🎉 Commande confirmée ! Merci pour votre achat.');
        }
      }).catch(() => {});
    }
    if (searchParams.get('order_canceled')) {
      toast.error('Commande annulée.');
    }
  }, [searchParams]);
  const [showSearch, setShowSearch] = useState(false);
  const [showLocationFilter, setShowLocationFilter] = useState(false);
  const [locationScope, setLocationScope] = useState<'local' | 'region' | 'country' | 'europe'>('country');
  const [selectedCountry, setSelectedCountry] = useState('FR');
  const [selectedRegion, setSelectedRegion] = useState('');
  const [selectedCity, setSelectedCity] = useState('');

  const locationFilter: LocationFilter = useMemo(() => ({
    scope: locationScope,
    country: locationScope !== 'europe' ? selectedCountry : undefined,
    region: (locationScope === 'region' || locationScope === 'local') ? selectedRegion || undefined : undefined,
    city: locationScope === 'local' ? selectedCity || undefined : undefined,
  }), [locationScope, selectedCountry, selectedRegion, selectedCity]);

  const regions = useMemo(() => {
    const data = GEO_DATA[selectedCountry];
    return data ? Object.keys(data).sort() : [];
  }, [selectedCountry]);

  const cities = useMemo(() => {
    const data = GEO_DATA[selectedCountry];
    if (!data || !selectedRegion) return [];
    return (data[selectedRegion] || []).map(v => v.nom).sort();
  }, [selectedCountry, selectedRegion]);

  const { data: products = [], isLoading } = useProducts(category, search, locationFilter);
  const { data: seller } = useSellerProfile();
  const { data: favorites = [] } = useProductFavorites();

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab === 'seller') setActiveTab('seller');
  }, [searchParams]);

  // Sort products
  const sortedProducts = [...products].sort((a, b) => {
    switch (sortBy) {
      case 'popular': return (b.view_count || 0) - (a.view_count || 0);
      case 'price-asc': return a.price - b.price;
      case 'price-desc': return b.price - a.price;
      default: return 0; // already sorted by recent
    }
  });

  const favCount = favorites.length;

  return (
    <AppLayout fullWidth>
      <SEOHead title="Marketplace - ForSure" description="Achetez et vendez sur ForSure" />
      <div className="pb-4 space-y-0">
        {/* Hero Header */}
        <div className="relative overflow-hidden bg-[image:var(--premium-gradient)] px-4 pt-5 pb-6 -mx-4 md:-mx-0 md:rounded-2xl mb-4">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_0%,hsl(0_0%_100%/0.1),transparent_50%)]" />
          <div className="relative z-10">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h1 className="text-2xl font-bold text-primary-foreground font-display flex items-center gap-2">
                  <ShoppingBag className="w-6 h-6" />
                  Marketplace
                </h1>
                <p className="text-primary-foreground/70 text-xs mt-0.5">Achetez, vendez, échangez</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowLocationFilter(!showLocationFilter)}
                  className="w-9 h-9 rounded-xl bg-primary-foreground/15 backdrop-blur-sm flex items-center justify-center text-primary-foreground hover:bg-primary-foreground/25 transition-colors"
                >
                  {showLocationFilter ? <X className="w-4 h-4" /> : <MapPin className="w-4 h-4" />}
                </button>
                <Link to="/marketplace?tab=browse" onClick={() => setShowSearch(false)}>
                  <button
                    onClick={(e) => { e.preventDefault(); setShowSearch(!showSearch); }}
                    className="w-9 h-9 rounded-xl bg-primary-foreground/15 backdrop-blur-sm flex items-center justify-center text-primary-foreground hover:bg-primary-foreground/25 transition-colors"
                  >
                    {showSearch ? <X className="w-4 h-4" /> : <Search className="w-4 h-4" />}
                  </button>
                </Link>
                <Link to="/marketplace?favorites=true" className="relative">
                  <div className="w-9 h-9 rounded-xl bg-primary-foreground/15 backdrop-blur-sm flex items-center justify-center text-primary-foreground hover:bg-primary-foreground/25 transition-colors">
                    <Heart className="w-4 h-4" />
                    {favCount > 0 && (
                      <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center px-[3px]">
                        {favCount}
                      </span>
                    )}
                  </div>
                </Link>
                <CartSheet />
              </div>
            </div>

            {/* Search bar */}
            {showSearch && (
              <div className="relative animate-slide-up">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Rechercher un article, une marque..."
                  className="pl-10 bg-primary-foreground/95 border-0 rounded-xl h-11 text-foreground placeholder:text-muted-foreground shadow-lg"
                  autoFocus
                />
                {search && (
                  <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2">
                    <X className="w-4 h-4 text-muted-foreground" />
                  </button>
                )}
              </div>
            )}

            {/* Location filter */}
            {showLocationFilter && (
              <div className="space-y-2 animate-slide-up">
                {/* Scope selector */}
                <div className="flex gap-1.5">
                  {LOCATION_SCOPES.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => {
                        setLocationScope(s.value as any);
                        if (s.value === 'europe') { setSelectedRegion(''); setSelectedCity(''); }
                      }}
                      className={cn(
                        'flex items-center gap-1 px-3 py-1.5 rounded-full text-[11px] font-medium transition-all flex-shrink-0 border',
                        locationScope === s.value
                          ? 'border-primary/30 bg-primary/10 text-primary'
                          : 'border-primary-foreground/20 text-primary-foreground/70 hover:border-primary-foreground/40'
                      )}
                    >
                      <span>{s.icon}</span>
                      {s.label}
                    </button>
                  ))}
                </div>

                {/* Dropdowns */}
                {locationScope !== 'europe' && (
                  <div className="flex gap-2">
                    <Select value={selectedCountry} onValueChange={(v) => { setSelectedCountry(v); setSelectedRegion(''); setSelectedCity(''); }}>
                      <SelectTrigger className="h-9 bg-primary-foreground/95 border-0 rounded-xl text-foreground text-xs flex-1">
                        <SelectValue placeholder="Pays" />
                      </SelectTrigger>
                      <SelectContent>
                        {COUNTRIES.map((c) => (
                          <SelectItem key={c.code} value={c.code}>{c.flag} {c.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {(locationScope === 'region' || locationScope === 'local') && regions.length > 0 && (
                      <Select value={selectedRegion} onValueChange={(v) => { setSelectedRegion(v); setSelectedCity(''); }}>
                        <SelectTrigger className="h-9 bg-primary-foreground/95 border-0 rounded-xl text-foreground text-xs flex-1">
                          <SelectValue placeholder="Région" />
                        </SelectTrigger>
                        <SelectContent>
                          {regions.map((r) => (
                            <SelectItem key={r} value={r}>{r}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}

                    {locationScope === 'local' && selectedRegion && cities.length > 0 && (
                      <Select value={selectedCity} onValueChange={setSelectedCity}>
                        <SelectTrigger className="h-9 bg-primary-foreground/95 border-0 rounded-xl text-foreground text-xs flex-1">
                          <SelectValue placeholder="Ville" />
                        </SelectTrigger>
                        <SelectContent>
                          {cities.map((c) => (
                            <SelectItem key={c} value={c}>{c}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="w-full bg-card/80 backdrop-blur-md rounded-2xl p-1.5 h-auto border border-border/30 shadow-[var(--shadow-sm)]">
            <TabsTrigger value="browse" className="flex-1 rounded-xl data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-[0_4px_16px_hsl(var(--primary)/0.3)] py-3 text-xs font-bold gap-2 transition-all duration-300">
              <Sparkles className="w-4 h-4" />
              Explorer
            </TabsTrigger>
            <TabsTrigger value="seller" className="flex-1 rounded-xl data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-[0_4px_16px_hsl(var(--primary)/0.3)] py-3 text-xs font-bold gap-2 transition-all duration-300">
              <Store className="w-4 h-4" />
              Ma boutique
            </TabsTrigger>
          </TabsList>

          <TabsContent value="browse" className="space-y-3 mt-3">
            {/* Categories - horizontal scroll */}
            <ScrollArea className="w-full">
              <div className="flex gap-2 pb-1 px-0.5">
            {CATEGORIES.map((cat) => (
                  <button
                    key={cat.value}
                    onClick={() => setCategory(cat.value)}
                    className={cn(
                      'flex flex-col items-center gap-1.5 px-4 py-2.5 rounded-2xl transition-all duration-300 flex-shrink-0 min-w-[68px] border backdrop-blur-sm',
                      category === cat.value
                        ? 'bg-primary text-primary-foreground shadow-[0_4px_20px_hsl(var(--primary)/0.4)] border-primary/50 scale-[1.05] -translate-y-0.5'
                        : 'bg-card/80 text-muted-foreground hover:bg-card hover:shadow-[var(--shadow-md)] hover:-translate-y-0.5 border-border/30 hover:border-border/60'
                    )}
                  >
                    <span className="text-xl leading-none drop-shadow-sm">{cat.icon}</span>
                    <span className="text-[10px] font-bold tracking-wide leading-none">{cat.label}</span>
                  </button>
                ))}
              </div>
              <ScrollBar orientation="horizontal" className="h-0" />
            </ScrollArea>

            {/* Sort row */}
            <div className="flex gap-1.5 overflow-x-auto scrollbar-none">
              {SORT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setSortBy(opt.value)}
                  className={cn(
                    'flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[11px] font-semibold transition-all duration-300 flex-shrink-0 border backdrop-blur-sm',
                    sortBy === opt.value
                      ? 'border-primary/40 bg-primary/10 text-primary shadow-[0_2px_12px_hsl(var(--primary)/0.15)]'
                      : 'border-border/30 bg-card/60 text-muted-foreground hover:border-primary/20 hover:bg-card/90 hover:text-foreground'
                  )}
                >
                  <opt.icon className="w-3.5 h-3.5" />
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Products grid */}
            {isLoading ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="rounded-2xl overflow-hidden">
                    <div className="skeleton aspect-[3/4]" />
                    <div className="p-2.5 space-y-2">
                      <div className="skeleton h-3 w-3/4" />
                      <div className="skeleton h-4 w-1/3" />
                    </div>
                  </div>
                ))}
              </div>
            ) : sortedProducts.length === 0 ? (
              <div className="text-center py-20">
                <div className="w-20 h-20 rounded-3xl bg-secondary/60 flex items-center justify-center mx-auto mb-4">
                  <ShoppingBag className="w-10 h-10 text-muted-foreground" />
                </div>
                <h3 className="font-bold text-lg">Aucun article trouvé</h3>
                <p className="text-muted-foreground text-sm mt-1 max-w-xs mx-auto">
                  {search ? 'Essayez un autre terme' : 'Soyez le premier à vendre !'}
                </p>
                {seller && (
                  <CreateProductDialog
                    sellerId={seller.id}
                    trigger={
                      <Button className="mt-4 premium-button">
                        <Plus className="w-4 h-4 mr-2" />
                        Vendre un article
                      </Button>
                    }
                  />
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5">
                {sortedProducts.map((product) => (
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

      {/* Floating sell button */}
      {seller && activeTab === 'browse' && (
        <CreateProductDialog
          sellerId={seller.id}
          trigger={
            <Button
              className="fixed bottom-20 right-4 z-50 md:hidden h-12 w-12 rounded-2xl shadow-[var(--shadow-gold)] bg-[image:var(--premium-gradient)] text-primary-foreground border-0 active:scale-90 transition-transform"
            >
              <Plus className="w-6 h-6 stroke-[2.5]" />
            </Button>
          }
        />
      )}
    </AppLayout>
  );
}
