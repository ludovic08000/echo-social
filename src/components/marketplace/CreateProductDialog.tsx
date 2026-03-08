import { useState, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Plus, Upload, Sparkles, Loader2, Check } from 'lucide-react';
import { useCreateProduct } from '@/hooks/useMarketplace';
import { useImageUpload } from '@/hooks/useImageUpload';
import { ScrollArea } from '@/components/ui/scroll-area';
import { COUNTRIES, GEO_DATA } from '@/lib/geoData';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';

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

const CONDITIONS = [
  { value: 'new', label: 'Neuf' },
  { value: 'like_new', label: 'Comme neuf' },
  { value: 'very_good', label: 'Très bon état' },
  { value: 'good', label: 'Bon état' },
  { value: 'fair', label: 'État correct' },
  { value: 'for_parts', label: 'Pour pièces' },
];

const SIZES = [
  'XS', 'S', 'M', 'L', 'XL', 'XXL', 'Unique', 'Sur mesure',
];

const SHIPPING_TYPES = [
  { value: 'standard', label: 'Standard (3-5j)' },
  { value: 'express', label: 'Express (1-2j)' },
  { value: 'pickup', label: 'Retrait en main propre' },
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
  const [productType] = useState<'physical'>('physical');
  const [condition, setCondition] = useState('good');
  const [stock, setStock] = useState('');
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  const [size, setSize] = useState('');
  const [color, setColor] = useState('');
  const [shippingType, setShippingType] = useState('standard');
  const [shippingPrice, setShippingPrice] = useState('');
  const [weightGrams, setWeightGrams] = useState('');
  const [country, setCountry] = useState('FR');
  const [region, setRegion] = useState('');
  const [city, setCity] = useState('');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiResult, setAiResult] = useState('');

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

  const generateAIDescription = async () => {
    if (!title.trim()) {
      toast.error('Remplissez le titre du produit d\'abord');
      return;
    }
    setAiGenerating(true);
    setAiResult('');
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/seller-ai-coach`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            action: 'generate_description',
            productInfo: title.trim() + (description.trim() ? ` — ${description.trim()}` : ''),
            category,
            price: price ? parseFloat(price) : undefined,
          }),
        }
      );
      if (!response.ok) throw new Error('Erreur IA');
      if (!response.body) throw new Error('Pas de réponse');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line.startsWith('data: ') || line.trim() === '') continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') break;
          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              full += content;
              setAiResult(full);
            }
          } catch {}
        }
      }
    } catch (e: any) {
      toast.error(e.message || 'Erreur lors de la génération');
    } finally {
      setAiGenerating(false);
    }
  };

  const applyAIDescription = () => {
    // Strip markdown formatting for clean text in the description field
    const clean = aiResult
      .replace(/#{1,6}\s/g, '')
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .trim();
    setDescription(clean);
    setAiResult('');
    toast.success('Description appliquée !');
  };

  const handleSubmit = () => {
    if (!title.trim() || !price || !weightGrams) {
      if (!weightGrams) toast.error('Veuillez indiquer le poids du produit');
      return;
    }
    createProduct.mutate(
      {
        seller_id: sellerId,
        title: title.trim(),
        description: description.trim() || undefined,
        price: parseFloat(price),
        category,
        product_type: 'physical',
        thumbnail_url: thumbnailUrl || undefined,
        images: thumbnailUrl ? [thumbnailUrl] : undefined,
        stock_quantity: stock ? parseInt(stock) : undefined,
        size: size || undefined,
        color: color || undefined,
        condition,
        shipping_type: shippingType,
        shipping_price: shippingPrice ? parseFloat(shippingPrice) : 0,
        weight_grams: parseInt(weightGrams),
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
    setCondition('good');
    setStock('');
    setThumbnailUrl('');
    setSize('');
    setColor('');
    setShippingType('standard');
    setShippingPrice('');
    setWeightGrams('');
    setCountry('FR');
    setRegion('');
    setCity('');
    setAiResult('');
    setAiGenerating(false);
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

            {/* Description + AI */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Description</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={generateAIDescription}
                  disabled={aiGenerating || !title.trim()}
                >
                  {aiGenerating ? (
                    <><Loader2 className="w-3 h-3 animate-spin" /> Génération...</>
                  ) : (
                    <><Sparkles className="w-3 h-3" /> Générer avec l'IA</>
                  )}
                </Button>
              </div>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Décrivez votre produit ou utilisez l'IA ✨" className="mt-1" rows={3} />
              
              {aiResult && (
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
                  <p className="text-[11px] font-medium text-primary flex items-center gap-1">
                    <Sparkles className="w-3 h-3" /> Suggestion IA — vérifiez puis validez
                  </p>
                  <div className="text-xs prose prose-sm max-w-none">
                    <ReactMarkdown>{aiResult}</ReactMarkdown>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" className="flex-1 h-7 text-xs" onClick={applyAIDescription}>
                      <Check className="w-3 h-3 mr-1" /> Utiliser cette description
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAiResult('')}>
                      Ignorer
                    </Button>
                  </div>
                </div>
              )}
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

            {/* Category & Condition */}
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
                <Label>État *</Label>
                <Select value={condition} onValueChange={setCondition}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CONDITIONS.map((c) => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
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

            {/* Weight (for physical) */}
            {productType === 'physical' && (
              <div>
                <Label>Poids du produit (grammes) *</Label>
                <Select value={weightGrams} onValueChange={setWeightGrams}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder="Sélectionner le poids" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="250">250g</SelectItem>
                    <SelectItem value="500">500g</SelectItem>
                    <SelectItem value="1000">1 kg</SelectItem>
                    <SelectItem value="2000">2 kg</SelectItem>
                    <SelectItem value="5000">5 kg</SelectItem>
                    <SelectItem value="10000">10 kg</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground mt-1">Les frais Mondial Relay seront calculés automatiquement</p>
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
