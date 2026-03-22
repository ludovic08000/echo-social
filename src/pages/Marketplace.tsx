import { useState, useEffect, useMemo } from 'react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { AppLayout } from '@/components/AppLayout';
import { useProducts, LocationFilter, useMyOrders } from '@/hooks/useMarketplace';
import { useIsMarketplaceEnabled } from '@/hooks/usePlatformStats';
import { ProductCard } from '@/components/marketplace/ProductCard';
import { CartSheet } from '@/components/marketplace/CartSheet';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Search, Store, Plus, ShoppingBag, Sparkles, Flame, Clock, SlidersHorizontal, X, Heart, TrendingUp, Tag, MapPin, Globe, Truck, Package, CheckCircle, AlertCircle, Copy, Star } from 'lucide-react';
import { SellerDashboard } from '@/components/marketplace/SellerDashboard';
import { SEOHead } from '@/components/SEOHead';
import { CreateProductDialog } from '@/components/marketplace/CreateProductDialog';
import { useSellerProfile } from '@/hooks/useMarketplace';
import { useProductFavorites } from '@/hooks/useProductFavorites';
import { cn } from '@/lib/utils';
import { BROWSE_CATEGORIES } from '@/lib/marketplaceCategories';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { COUNTRIES, GEO_DATA } from '@/lib/geoData';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { SellerReviewDialog } from '@/components/marketplace/SellerReviewDialog';
import { useHasReviewedOrder } from '@/hooks/useSellerReviews';

function ReviewSellerButton({ order }: { order: any }) {
  const [showReview, setShowReview] = useState(false);
  const { data: hasReviewed } = useHasReviewedOrder(order.id);
  const sellerProfileId = order.order_items?.[0]?.seller_id;
  if (!sellerProfileId || hasReviewed) return null;
  return (
    <>
      <Button variant="outline" size="sm" className="w-full rounded-xl text-xs gap-1.5 mt-1" onClick={() => setShowReview(true)}>
        <Star className="w-3.5 h-3.5" /> Évaluer le vendeur
      </Button>
      <SellerReviewDialog
        open={showReview}
        onOpenChange={setShowReview}
        sellerProfileId={sellerProfileId}
        orderId={order.id}
      />
    </>
  );
}

const CATEGORIES = BROWSE_CATEGORIES;

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
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') || 'browse');
  const [sortBy, setSortBy] = useState('recent');
  const [orderConfirmation, setOrderConfirmation] = useState<any>(null);
  const { enabled: marketEnabled, userCount, threshold: marketThreshold, loading: marketLoading } = useIsMarketplaceEnabled();

  const { data: myOrders = [], refetch: refetchOrders } = useMyOrders();

  const marketGated = !marketLoading && !marketEnabled;

  // Handle order success - show confirmation dialog
  useEffect(() => {
    const orderId = searchParams.get('order_success');
    if (orderId) {
      setActiveTab('orders');
      supabase.functions.invoke('marketplace-checkout', {
        body: { action: 'verify_payment', orderId },
      }).then(({ data }) => {
        if (data?.paid || data?.order) {
          refetchOrders();
          // Find the order to show confirmation
          const findOrder = async () => {
            const { data: order } = await supabase
              .from('orders')
              .select('*, order_items(*, products(title, thumbnail_url))')
              .eq('id', orderId)
              .single();
            if (order) setOrderConfirmation(order);
          };
          findOrder();
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
    return (data[selectedRegion] || []).filter(v => v.population >= 3000).map(v => v.nom).sort();
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

  if (marketGated) {
    const progress = Math.min(100, Math.round((userCount / marketThreshold) * 100));
    return (
      <AppLayout>
        <SEOHead title="Marketplace — Forsure" description="La marketplace Forsure" />
        <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 gap-6">
          <div className="w-20 h-20 rounded-2xl bg-muted/30 border border-border flex items-center justify-center">
            <ShoppingBag className="w-10 h-10 text-muted-foreground" />
          </div>
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold text-foreground">Marketplace bientôt disponible</h1>
            <p className="text-muted-foreground text-sm max-w-md">
              La marketplace s'active automatiquement lorsque la communauté atteint <strong className="text-foreground">{marketThreshold.toLocaleString('fr-FR')}</strong> membres.
            </p>
          </div>
          <div className="w-full max-w-xs space-y-2">
            <div className="h-3 rounded-full bg-muted/50 overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-1000"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{userCount.toLocaleString('fr-FR')} membres</span>
              <span>{marketThreshold.toLocaleString('fr-FR')}</span>
            </div>
          </div>
          <Button variant="outline" onClick={() => navigate('/feed')} className="rounded-xl">
            Retour au feed
          </Button>
        </div>
      </AppLayout>
    );
  }

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
                {seller && (
                  <Link to="/marketplace?tab=seller&sellerTab=orders">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-9 rounded-xl text-xs gap-1.5"
                    >
                      <Truck className="w-4 h-4" />
                      Étiquettes
                    </Button>
                  </Link>
                )}
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
            <TabsTrigger value="orders" className="flex-1 rounded-xl data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-[0_4px_16px_hsl(var(--primary)/0.3)] py-3 text-xs font-bold gap-2 transition-all duration-300 relative">
              <Package className="w-4 h-4" />
              Mes achats
              {myOrders.length > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center px-[3px]">
                  {myOrders.length}
                </span>
              )}
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
                      'flex flex-col items-center justify-center gap-1.5 w-[72px] h-[72px] rounded-2xl transition-all duration-300 flex-shrink-0 border backdrop-blur-sm',
                      category === cat.value
                        ? 'bg-primary text-primary-foreground shadow-[0_4px_20px_hsl(var(--primary)/0.4)] border-primary/50 scale-[1.05] -translate-y-0.5'
                        : 'bg-card/80 text-muted-foreground hover:bg-card hover:shadow-[var(--shadow-md)] hover:-translate-y-0.5 border-border/30 hover:border-border/60'
                    )}
                  >
                    <span className="text-xl leading-none drop-shadow-sm">{cat.icon}</span>
                    <span className="text-[10px] font-bold tracking-wide leading-none truncate max-w-[60px]">{cat.label}</span>
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
              <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                {Array.from({ length: 12 }).map((_, i) => (
                  <div key={i} className="rounded-xl overflow-hidden">
                    <div className="skeleton aspect-square" />
                    <div className="p-1.5 space-y-1">
                      <div className="skeleton h-2.5 w-3/4" />
                      <div className="skeleton h-3 w-1/3" />
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
            ) : category !== 'all' ? (
              <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                {sortedProducts.map((product) => (
                  <ProductCard key={product.id} product={product} compact />
                ))}
              </div>
            ) : (
              <div className="space-y-6">
                {CATEGORIES.filter(c => c.value !== 'all').map((cat) => {
                  const catProducts = sortedProducts.filter((p: any) => p.category === cat.value);
                  if (catProducts.length === 0) return null;
                  return (
                    <div key={cat.value} className="space-y-2.5">
                      <div className="flex items-center justify-between px-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-lg">{cat.icon}</span>
                          <h2 className="font-bold text-sm text-foreground">{cat.label}</h2>
                          <span className="text-[10px] font-medium text-muted-foreground bg-secondary/60 px-2 py-0.5 rounded-full">{catProducts.length}</span>
                        </div>
                        <button
                          onClick={() => setCategory(cat.value)}
                          className="text-[11px] font-semibold text-primary hover:underline"
                        >
                          Tout voir
                        </button>
                      </div>
                      <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                        {catProducts.slice(0, 6).map((product: any) => (
                          <ProductCard key={product.id} product={product} compact />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* Orders tab */}
          <TabsContent value="orders" className="mt-4 space-y-3">
            {myOrders.length === 0 ? (
              <div className="text-center py-16">
                <div className="w-16 h-16 rounded-2xl bg-secondary/60 flex items-center justify-center mx-auto mb-3">
                  <Package className="w-8 h-8 text-muted-foreground" />
                </div>
                <h3 className="font-bold text-base">Aucune commande</h3>
                <p className="text-muted-foreground text-sm mt-1">Vos achats apparaîtront ici</p>
              </div>
            ) : (
              myOrders.map((order: any) => {
                const statusConfig: Record<string, { label: string; color: string; icon: any }> = {
                  pending: { label: 'En attente', color: 'text-amber-500', icon: Clock },
                  paid: { label: 'Payée', color: 'text-green-500', icon: CheckCircle },
                  shipped: { label: 'Expédiée', color: 'text-blue-500', icon: Truck },
                  delivered: { label: 'Livrée', color: 'text-green-600', icon: CheckCircle },
                  cancelled: { label: 'Annulée', color: 'text-destructive', icon: AlertCircle },
                };
                const status = statusConfig[order.status] || statusConfig.pending;
                const StatusIcon = status.icon;
                return (
                  <div key={order.id} className="bg-card rounded-2xl border border-border/30 p-4 space-y-3 shadow-[var(--shadow-sm)]">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <StatusIcon className={cn('w-4 h-4', status.color)} />
                        <span className={cn('text-xs font-bold', status.color)}>{status.label}</span>
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        {format(new Date(order.created_at), 'dd MMM yyyy à HH:mm', { locale: fr })}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 bg-secondary/40 rounded-xl px-3 py-2">
                      <span className="text-[10px] text-muted-foreground">N°</span>
                      <span className="text-xs font-mono font-bold text-foreground flex-1">{order.order_number}</span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(order.order_number);
                          toast.success('Numéro copié !');
                        }}
                        className="text-muted-foreground hover:text-primary transition-colors"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Items */}
                    <div className="space-y-2">
                      {(order.order_items || []).map((item: any) => (
                        <div key={item.id} className="flex items-center gap-3">
                          {item.products?.thumbnail_url ? (
                            <img src={item.products.thumbnail_url} alt="" className="w-10 h-10 rounded-lg object-cover bg-muted" />
                          ) : (
                            <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                              <Package className="w-4 h-4 text-muted-foreground" />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium truncate">{item.title}</p>
                            <p className="text-[10px] text-muted-foreground">x{item.quantity} — {item.price?.toFixed(2)} €</p>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Tracking */}
                    {order.tracking_number ? (
                      <button
                        onClick={() => window.open(`https://www.mondialrelay.fr/suivi-de-colis/?NumeroExpedition=${order.tracking_number}`, '_blank')}
                        className="flex items-center gap-2 bg-blue-500/10 hover:bg-blue-500/20 rounded-xl px-3 py-2.5 w-full transition-colors cursor-pointer"
                      >
                        <Truck className="w-4 h-4 text-blue-500" />
                        <div className="flex-1 text-left">
                          <p className="text-[10px] text-muted-foreground">Numéro de suivi</p>
                          <p className="text-xs font-mono font-bold text-blue-600">{order.tracking_number}</p>
                        </div>
                        <span className="text-[11px] text-blue-500 font-semibold whitespace-nowrap">Suivre →</span>
                      </button>
                    ) : order.status === 'paid' ? (
                      <div className="flex items-center gap-2 bg-amber-500/10 rounded-xl px-3 py-2.5 w-full">
                        <Clock className="w-4 h-4 text-amber-500" />
                        <div className="flex-1">
                          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">En attente d'expédition</p>
                          <p className="text-[10px] text-muted-foreground">Le vendeur prépare votre colis. Le numéro de suivi apparaîtra ici dès l'envoi.</p>
                        </div>
                      </div>
                    ) : null}

                    {/* Relay point info */}
                    {order.shipping_relay_name && (
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        <MapPin className="w-3 h-3" />
                        <span>Point relais : {order.shipping_relay_name}, {order.shipping_relay_city}</span>
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-1 border-t border-border/20">
                      <span className="text-xs text-muted-foreground">Total</span>
                      <span className="text-sm font-bold text-foreground">{order.total?.toFixed(2)} €</span>
                    </div>

                    {/* Review seller button for delivered orders */}
                    {order.status === 'delivered' && (
                      <ReviewSellerButton order={order} />
                    )}
                  </div>
                );
              })
            )}
          </TabsContent>

          <TabsContent value="seller" className="mt-4">
            <SellerDashboard />
          </TabsContent>
        </Tabs>

        {/* Order confirmation dialog */}
        <Dialog open={!!orderConfirmation} onOpenChange={(open) => !open && setOrderConfirmation(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg">
                <CheckCircle className="w-6 h-6 text-green-500" />
                Commande confirmée !
              </DialogTitle>
            </DialogHeader>
            {orderConfirmation && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">Merci pour votre achat 🎉</p>
                
                <div className="bg-secondary/40 rounded-xl px-4 py-3 space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">N° de commande</span>
                    <span className="font-mono font-bold">{orderConfirmation.order_number}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Total payé</span>
                    <span className="font-bold">{orderConfirmation.total?.toFixed(2)} €</span>
                  </div>
                  {orderConfirmation.shipping_relay_name && (
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Point relais</span>
                      <span className="font-medium">{orderConfirmation.shipping_relay_name}</span>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  {(orderConfirmation.order_items || []).map((item: any) => (
                    <div key={item.id} className="flex items-center gap-3">
                      {item.products?.thumbnail_url ? (
                        <img src={item.products.thumbnail_url} alt="" className="w-10 h-10 rounded-lg object-cover bg-muted" />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                          <Package className="w-4 h-4 text-muted-foreground" />
                        </div>
                      )}
                      <div className="flex-1">
                        <p className="text-xs font-medium">{item.title}</p>
                        <p className="text-[10px] text-muted-foreground">x{item.quantity}</p>
                      </div>
                      <span className="text-xs font-bold">{item.subtotal?.toFixed(2)} €</span>
                    </div>
                  ))}
                </div>

                <p className="text-[11px] text-muted-foreground text-center">
                  Le vendeur va préparer votre colis. Vous recevrez le numéro de suivi dès l'expédition.
                </p>

                <Button className="w-full" onClick={() => setOrderConfirmation(null)}>
                  OK, compris !
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {/* Floating sell button */}
      {seller && activeTab === 'browse' && (
        <CreateProductDialog
          sellerId={seller.id}
          trigger={
            <Button
              className="fixed bottom-20 right-4 z-50 md:hidden h-14 w-14 rounded-2xl shadow-[0_8px_32px_hsl(var(--primary)/0.4)] bg-[image:var(--premium-gradient)] text-primary-foreground border-0 active:scale-90 transition-all duration-300 hover:shadow-[0_12px_40px_hsl(var(--primary)/0.5)] hover:-translate-y-1"
            >
              <Plus className="w-6 h-6 stroke-[2.5]" />
            </Button>
          }
        />
      )}
    </AppLayout>
  );
}
