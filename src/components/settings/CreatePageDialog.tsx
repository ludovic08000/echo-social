import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Image, Globe, Phone, Mail, MapPin, Building2 } from 'lucide-react';
import { useCreatePage } from '@/hooks/usePages';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';

const PAGE_CATEGORIES = [
  { value: 'business', label: 'Entreprise' },
  { value: 'brand', label: 'Marque' },
  { value: 'artist', label: 'Artiste/Créateur' },
  { value: 'community', label: 'Communauté' },
  { value: 'entertainment', label: 'Divertissement' },
  { value: 'sports', label: 'Sports' },
  { value: 'news', label: 'Actualités' },
  { value: 'education', label: 'Éducation' },
  { value: 'nonprofit', label: 'Association' },
  { value: 'general', label: 'Autre' },
];

interface CreatePageDialogProps {
  children: React.ReactNode;
}

export function CreatePageDialog({ children }: CreatePageDialogProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('general');
  const [website, setWebsite] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  
  const createPage = useCreatePage();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!name.trim()) {
      toast({
        title: 'Erreur',
        description: 'Le nom de la page est requis',
        variant: 'destructive',
      });
      return;
    }

    try {
      const data = await createPage.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        category,
        website_url: website.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        address: address.trim() || undefined,
      });
      
      toast({
        title: 'Page créée !',
        description: `La page "${name}" a été créée avec succès`,
      });
      
      // Reset form
      setName('');
      setDescription('');
      setCategory('general');
      setWebsite('');
      setPhone('');
      setEmail('');
      setAddress('');
      setOpen(false);
      navigate(`/pages/${data.id}`);
    } catch (error) {
      toast({
        title: 'Erreur',
        description: 'Impossible de créer la page',
        variant: 'destructive',
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[550px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            Créer une page
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Cover and profile preview */}
          <div className="relative h-32 bg-gradient-to-br from-primary/20 to-accent/20 rounded-xl">
            <div className="absolute inset-0 flex items-center justify-center cursor-pointer hover:bg-black/10 transition-colors rounded-xl">
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <Image className="w-8 h-8" />
                <span className="text-sm">Photo de couverture</span>
              </div>
            </div>
            <div className="absolute -bottom-8 left-4">
              <div className="w-20 h-20 rounded-full bg-secondary border-4 border-background flex items-center justify-center cursor-pointer hover:bg-secondary/80 transition-colors">
                <Building2 className="w-8 h-8 text-muted-foreground" />
              </div>
            </div>
          </div>

          <div className="pt-6 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="page-name">Nom de la page *</Label>
                <Input
                  id="page-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Nom de votre page"
                  className="premium-input"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="page-category">Catégorie</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger className="premium-input">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAGE_CATEGORIES.map((cat) => (
                      <SelectItem key={cat.value} value={cat.value}>
                        {cat.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="page-description">Description</Label>
              <Textarea
                id="page-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Décrivez votre page..."
                className="premium-input min-h-[80px] resize-none"
              />
            </div>

            {/* Contact info */}
            <div className="space-y-3">
              <Label className="text-base font-semibold">Informations de contact</Label>
              
              <div className="grid grid-cols-2 gap-3">
                <div className="relative">
                  <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="Site web"
                    className="premium-input pl-10"
                  />
                </div>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="Téléphone"
                    className="premium-input pl-10"
                  />
                </div>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Email"
                    className="premium-input pl-10"
                  />
                </div>
                <div className="relative">
                  <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Adresse"
                    className="premium-input pl-10"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={createPage.isPending} className="premium-button">
              {createPage.isPending ? 'Création...' : 'Créer la page'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
