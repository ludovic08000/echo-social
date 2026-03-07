import { useState, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Plus, Upload, ShoppingBag } from 'lucide-react';
import { useCreateProduct } from '@/hooks/useMarketplace';
import { useImageUpload } from '@/hooks/useImageUpload';
import { ScrollArea } from '@/components/ui/scroll-area';
import { COUNTRIES, GEO_DATA } from '@/lib/geoData';

const CATEGORIES = [
  { value: 'general', label: 'Général' },
  { value: 'fashion', label: 'Mode' },
  { value: 'electronics', label: 'Électronique' },
  { value: 'art', label: 'Art & Créations' },
  { value: 'beauty', label: 'Beauté' },
  { value: 'home', label: 'Maison' },
  { value: 'sports', label: 'Sport' },
  { value: 'books', label: 'Livres' },
  { value: 'services', label: 'Services' },
  { value: 'digital', label: 'Produits numériques' },
];

const COLORS = [
  'Noir', 'Blanc', 'Rouge', 'Bleu', 'Vert', 'Jaune', 'Rose', 'Violet', 'Orange', 'Gris', 'Marron', 'Beige', 'Multicolore', 'Autre',
];

const SIZES = [
  'XS', 'S', 'M', 'L', 'XL', 'XXL', 'Unique', 'Sur mesure',
];

const SHIPPING_TYPES = [
  { value: 'standard', label: 'Standard (3-5j)' },
  { value: 'express', label: 'Express (1-2j)' },
  { value: 'pickup', label: 'Retrait en main propre' },
  { value: 'digital', label: 'Livraison numérique' },
  { value: 'free', label: 'Gratuit' },
];

interface CreateProductDialogProps {
  sellerId: string;
  trigger?: React.ReactNode;
}

export function CreateProductDialog({ sellerId, trigger }: CreateProductDialogProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('general');
  const [productType, setProductType] = useState<'physical' | 'digital' | 'service'>('physical');
  const [stock, setStock] = useState('');
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  const [size, setSize] = useState('');
  const [color, setColor] = useState('');
  const [shippingType, setShippingType] = useState('standard');
  const [shippingPrice, setShippingPrice] = useState('');
  const [country, setCountry] = useState('FR');
  const [region, setRegion] = useState('');
  const [city, setCity] = useState('');

  const regions = useMemo(() => {
    const data = GEO_DATA[country];
    return data ? Object.keys(data).sort() : [];
  }, [country]);

  const cities = useMemo(() => {
    const data = GEO_DATA[country];
    if (!data || !region) return [];
    return (data[region] || []).map(v => v.nom).sort();
  }, [country, region]);
  const createProduct = useCreateProduct();
  const { upload, isUploading } = useImageUpload({
    bucket: 'products',
    onSuccess: (url) => setThumbnailUrl(url),
  });

  const handleSubmit = () => {
    if (!title.trim() || !price) return;
    createProduct.mutate(
      {
        seller_id: sellerId,
        title: title.trim(),
        description: description.trim() || undefined,
        price: parseFloat(price),
        category,
        product_type: productType,
        thumbnail_url: thumbnailUrl || undefined,
        images: thumbnailUrl ? [thumbnailUrl] : undefined,
        stock_quantity: stock ? parseInt(stock) : undefined,
        size: size || undefined,
        color: color || undefined,
        shipping_type: shippingType,
        shipping_price: shippingPrice ? parseFloat(shippingPrice) : 0,
        country,
        region: region || undefined,
        city: city || undefined,
      },
      {
        onSuccess: () => {
          setOpen(false);
          resetForm();
        },
      }
    );
  };

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setPrice('');
    setCategory('general');
    setProductType('physical');
    setStock('');
    setThumbnailUrl('');
    setSize('');
    setColor('');
    setShippingType('standard');
    setShippingPrice('');
    setCountry('FR');
    setRegion('');
    setCity('');
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button className="premium-button">
            <Plus className="w-4 h-4 mr-2" />
            Ajouter un produit
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md max-h-[90vh] p-0">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle>Nouveau produit</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[calc(90vh-80px)] px-6 pb-6">
          <div className="space-y-4">
            {/* Photo */}
            <div>
              <Label>Photo</Label>
              <div className="mt-1">
                {thumbnailUrl ? (
                  <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-muted">
                    <img src={thumbnailUrl} alt="Aperçu" className="w-full h-full object-cover" />
                    <Button variant="secondary" size="sm" className="absolute bottom-2 right-2" onClick={() => setThumbnailUrl('')}>
                      Changer
                    </Button>
                  </div>
                ) : (
                  <label className="flex flex-col items-center justify-center w-full aspect-video rounded-xl border-2 border-dashed border-border hover:border-primary/50 cursor-pointer transition-colors bg-muted/30">
                    <Upload className="w-6 h-6 text-muted-foreground mb-1" />
                    <span className="text-xs text-muted-foreground">{isUploading ? 'Upload...' : 'Ajouter une photo'}</span>
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) upload(file); }} />
                  </label>
                )}
              </div>
            </div>

            {/* Title */}
            <div>
              <Label>Titre *</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nom du produit" className="mt-1" />
            </div>

            {/* Description */}
            <div>
              <Label>Description</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Décrivez votre produit..." className="mt-1" rows={3} />
            </div>

            {/* Price & Stock */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Prix (€) *</Label>
                <Input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" className="mt-1" />
              </div>
              <div>
                <Label>Stock</Label>
                <Input type="number" min="0" value={stock} onChange={(e) => setStock(e.target.value)} placeholder="∞" className="mt-1" />
              </div>
            </div>

            {/* Category & Type */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Catégorie</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Type</Label>
                <Select value={productType} onValueChange={(v: any) => setProductType(v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="physical">Physique</SelectItem>
                    <SelectItem value="digital">Numérique</SelectItem>
                    <SelectItem value="service">Service</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Size & Color (only for physical) */}
            {productType === 'physical' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Taille</Label>
                  <Select value={size} onValueChange={setSize}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Optionnel" /></SelectTrigger>
                    <SelectContent>
                      {SIZES.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Couleur</Label>
                  <Select value={color} onValueChange={setColor}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Optionnel" /></SelectTrigger>
                    <SelectContent>
                      {COLORS.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* Shipping */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Livraison</Label>
                <Select value={shippingType} onValueChange={setShippingType}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SHIPPING_TYPES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {shippingType !== 'free' && shippingType !== 'digital' && shippingType !== 'pickup' && (
                <div>
                  <Label>Frais (€)</Label>
                  <Input type="number" min="0" step="0.01" value={shippingPrice} onChange={(e) => setShippingPrice(e.target.value)} placeholder="0.00" className="mt-1" />
                </div>
              )}
            </div>

            {/* Location */}
            <div className="space-y-2">
              <Label>Localisation</Label>
              <div className="grid grid-cols-3 gap-2">
                <Select value={country} onValueChange={(v) => { setCountry(v); setRegion(''); setCity(''); }}>
                  <SelectTrigger className="text-xs"><SelectValue placeholder="Pays" /></SelectTrigger>
                  <SelectContent>
                    {COUNTRIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>{c.flag} {c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {regions.length > 0 && (
                  <Select value={region} onValueChange={(v) => { setRegion(v); setCity(''); }}>
                    <SelectTrigger className="text-xs"><SelectValue placeholder="Région" /></SelectTrigger>
                    <SelectContent>
                      {regions.map((r) => (
                        <SelectItem key={r} value={r}>{r}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {cities.length > 0 && (
                  <Select value={city} onValueChange={setCity}>
                    <SelectTrigger className="text-xs"><SelectValue placeholder="Ville" /></SelectTrigger>
                    <SelectContent>
                      {cities.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>

            <Button onClick={handleSubmit} disabled={!title.trim() || !price || createProduct.isPending} className="w-full">
              {createProduct.isPending ? 'Création...' : 'Publier le produit'}
            </Button>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
