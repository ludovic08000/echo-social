import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Plus, Upload } from 'lucide-react';
import { useCreateProduct } from '@/hooks/useMarketplace';
import { useImageUpload } from '@/hooks/useImageUpload';

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

interface CreateProductDialogProps {
  sellerId: string;
}

export function CreateProductDialog({ sellerId }: CreateProductDialogProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('general');
  const [productType, setProductType] = useState<'physical' | 'digital' | 'service'>('physical');
  const [stock, setStock] = useState('');
  const [thumbnailUrl, setThumbnailUrl] = useState('');

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
      },
      {
        onSuccess: () => {
          setOpen(false);
          setTitle('');
          setDescription('');
          setPrice('');
          setCategory('general');
          setProductType('physical');
          setStock('');
          setThumbnailUrl('');
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="premium-button">
          <Plus className="w-4 h-4 mr-2" />
          Ajouter un produit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Nouveau produit</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Photo</Label>
            <div className="mt-1">
              {thumbnailUrl ? (
                <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-muted">
                  <img src={thumbnailUrl} alt="Aperçu" className="w-full h-full object-cover" />
                  <Button
                    variant="secondary"
                    size="sm"
                    className="absolute bottom-2 right-2"
                    onClick={() => setThumbnailUrl('')}
                  >
                    Changer
                  </Button>
                </div>
              ) : (
                <label className="flex flex-col items-center justify-center w-full aspect-video rounded-xl border-2 border-dashed border-border hover:border-primary/50 cursor-pointer transition-colors bg-muted/30">
                  <Upload className="w-6 h-6 text-muted-foreground mb-1" />
                  <span className="text-xs text-muted-foreground">{isUploading ? 'Upload...' : 'Ajouter une photo'}</span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) upload(file);
                    }}
                  />
                </label>
              )}
            </div>
          </div>

          <div>
            <Label>Titre *</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nom du produit" className="mt-1" />
          </div>

          <div>
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Décrivez votre produit..." className="mt-1" rows={3} />
          </div>

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

          <Button onClick={handleSubmit} disabled={!title.trim() || !price || createProduct.isPending} className="w-full">
            {createProduct.isPending ? 'Création...' : 'Publier le produit'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
