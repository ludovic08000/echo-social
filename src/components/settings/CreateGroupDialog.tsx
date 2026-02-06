import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, Lock, Globe, Image, X } from 'lucide-react';
import { useCreateGroup } from '@/hooks/useGroups';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { toast } from '@/hooks/use-toast';

interface CreateGroupDialogProps {
  children: React.ReactNode;
}

export function CreateGroupDialog({ children }: CreateGroupDialogProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [privacy, setPrivacy] = useState<'public' | 'private'>('public');
  
  const createGroup = useCreateGroup();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!name.trim()) {
      toast({
        title: 'Erreur',
        description: 'Le nom du groupe est requis',
        variant: 'destructive',
      });
      return;
    }

    try {
      const data = await createGroup.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        privacy,
      });
      
      toast({
        title: 'Groupe créé !',
        description: `Le groupe "${name}" a été créé avec succès`,
      });
      
      setName('');
      setDescription('');
      setPrivacy('public');
      setOpen(false);
      navigate(`/groups/${data.id}`);
    } catch (error) {
      toast({
        title: 'Erreur',
        description: 'Impossible de créer le groupe',
        variant: 'destructive',
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" />
            Créer un groupe
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Cover preview placeholder */}
          <div className="relative h-32 bg-gradient-to-br from-primary/20 to-accent/20 rounded-xl flex items-center justify-center cursor-pointer hover:from-primary/30 hover:to-accent/30 transition-colors">
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Image className="w-8 h-8" />
              <span className="text-sm">Ajouter une couverture</span>
            </div>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="group-name">Nom du groupe *</Label>
              <Input
                id="group-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: Fans de photographie"
                className="premium-input"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="group-description">Description</Label>
              <Textarea
                id="group-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Décrivez votre groupe..."
                className="premium-input min-h-[100px] resize-none"
              />
            </div>

            <div className="space-y-3">
              <Label>Confidentialité</Label>
              <RadioGroup value={privacy} onValueChange={(v) => setPrivacy(v as 'public' | 'private')}>
                <div className="flex items-start gap-3 p-4 rounded-xl bg-secondary/50 cursor-pointer hover:bg-secondary transition-colors">
                  <RadioGroupItem value="public" id="public" className="mt-1" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <Globe className="w-4 h-4 text-primary" />
                      <Label htmlFor="public" className="font-medium cursor-pointer">Public</Label>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      Tout le monde peut voir le groupe, ses membres et leurs publications
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-4 rounded-xl bg-secondary/50 cursor-pointer hover:bg-secondary transition-colors">
                  <RadioGroupItem value="private" id="private" className="mt-1" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <Lock className="w-4 h-4 text-primary" />
                      <Label htmlFor="private" className="font-medium cursor-pointer">Privé</Label>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      Seuls les membres peuvent voir les publications du groupe
                    </p>
                  </div>
                </div>
              </RadioGroup>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={createGroup.isPending} className="premium-button">
              {createGroup.isPending ? 'Création...' : 'Créer le groupe'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
