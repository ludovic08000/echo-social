import { useState } from 'react';
import { useSellerProfile, useCreateSellerProfile, useSellerProducts, useDeleteProduct } from '@/hooks/useMarketplace';
import { CreateProductDialog } from './CreateProductDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Store, Package, TrendingUp, Trash2, Eye } from 'lucide-react';
import { Link } from 'react-router-dom';

export function SellerDashboard() {
  const { data: seller, isLoading } = useSellerProfile();
  const { data: products = [] } = useSellerProducts();
  const createSeller = useCreateSellerProfile();
  const deleteProduct = useDeleteProduct();
  const [storeName, setStoreName] = useState('');

  if (isLoading) {
    return <div className="space-y-4"><div className="skeleton h-32 w-full" /><div className="skeleton h-32 w-full" /></div>;
  }

  if (!seller) {
    return (
      <Card className="premium-card">
        <CardContent className="p-6 text-center space-y-4">
          <div className="w-16 h-16 rounded-2xl bg-premium-gradient flex items-center justify-center mx-auto">
            <Store className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-xl font-bold">Ouvrir votre boutique</h2>
          <p className="text-muted-foreground text-sm max-w-sm mx-auto">
            Vendez vos produits, créations ou services à la communauté. Vous touchez 100% du prix de vente — les frais de 5% sont à la charge de l'acheteur.
          </p>
          <div className="flex gap-2 max-w-xs mx-auto">
            <Input
              value={storeName}
              onChange={(e) => setStoreName(e.target.value)}
              placeholder="Nom de votre boutique"
            />
            <Button
              onClick={() => createSeller.mutate(storeName)}
              disabled={!storeName.trim() || createSeller.isPending}
            >
              Créer
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="premium-card">
          <CardContent className="p-4 text-center">
            <Package className="w-5 h-5 mx-auto text-primary mb-1" />
            <p className="text-2xl font-bold">{products.length}</p>
            <p className="text-xs text-muted-foreground">Produits</p>
          </CardContent>
        </Card>
        <Card className="premium-card">
          <CardContent className="p-4 text-center">
            <TrendingUp className="w-5 h-5 mx-auto text-primary mb-1" />
            <p className="text-2xl font-bold">{seller.total_sales}</p>
            <p className="text-xs text-muted-foreground">Ventes</p>
          </CardContent>
        </Card>
        <Card className="premium-card">
          <CardContent className="p-4 text-center">
            <Store className="w-5 h-5 mx-auto text-primary mb-1" />
            <p className="text-2xl font-bold">{seller.total_revenue?.toFixed(0) || 0}€</p>
            <p className="text-xs text-muted-foreground">Revenus</p>
          </CardContent>
        </Card>
      </div>

      {/* Add product */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Mes produits</h2>
        <CreateProductDialog sellerId={seller.id} />
      </div>

      {/* Product list */}
      {products.length === 0 ? (
        <Card className="premium-card">
          <CardContent className="p-8 text-center">
            <Package className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground">Aucun produit encore. Ajoutez votre premier !</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {products.map((product) => (
            <div key={product.id} className="flex items-center gap-3 p-3 rounded-xl bg-card border border-border/40">
              <img
                src={product.thumbnail_url || product.images?.[0] || '/placeholder.svg'}
                alt={product.title}
                className="w-12 h-12 rounded-lg object-cover flex-shrink-0"
              />
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-medium truncate">{product.title}</h4>
                <p className="text-sm font-bold text-primary">{product.price.toFixed(2)}€</p>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground">{product.view_count} <Eye className="w-3 h-3 inline" /></span>
                <Link to={`/marketplace/product/${product.id}`}>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <Eye className="w-4 h-4" />
                  </Button>
                </Link>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => deleteProduct.mutate(product.id)}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
