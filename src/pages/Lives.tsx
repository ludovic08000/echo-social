import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radio, Plus, Users, TrendingUp } from 'lucide-react';
import { AppLayout } from '@/components/AppLayout';
import { LiveCard } from '@/components/LiveCard';
import { useLiveStreams, useStartLive } from '@/hooks/useLiveStreams';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

const CATEGORIES = [
  { value: 'general', label: 'Général' },
  { value: 'gaming', label: 'Gaming' },
  { value: 'music', label: 'Musique' },
  { value: 'sports', label: 'Sports' },
  { value: 'lifestyle', label: 'Lifestyle' },
  { value: 'education', label: 'Éducation' },
  { value: 'art', label: 'Art & Créatif' },
  { value: 'talk', label: 'Discussion' },
];

export default function Lives() {
  const navigate = useNavigate();
  const { data: lives, isLoading } = useLiveStreams();
  const startLive = useStartLive();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('general');
  const [hashtags, setHashtags] = useState('');
  const [filter, setFilter] = useState<'all' | 'following'>('all');

  const handleStartLive = async () => {
    if (!title.trim()) {
      toast({ title: 'Donne un titre à ton live', variant: 'destructive' });
      return;
    }

    try {
      const data = await startLive.mutateAsync({
        title,
        description,
        category,
        hashtags: hashtags.split(',').map(t => t.trim()).filter(Boolean),
      });

      setIsDialogOpen(false);
      setTitle('');
      setDescription('');
      setCategory('general');
      setHashtags('');

      toast({ title: 'Live démarré ! 🔴' });
      
      // Navigate to the live page
      if (data?.id) {
        navigate(`/live/${data.id}`);
      }
    } catch (error) {
      toast({ title: 'Erreur lors du démarrage', variant: 'destructive' });
    }
  };

  const filteredLives = lives || [];

  return (
    <AppLayout>
      {/* Header */}
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display text-2xl font-bold flex items-center gap-2">
            <Radio className="w-6 h-6 text-red-500" />
            Lives
          </h1>
          <p className="text-sm text-muted-foreground">
            {filteredLives.length} live{filteredLives.length !== 1 ? 's' : ''} en cours
          </p>
        </div>

        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="pulse-button-gradient">
              <Plus className="w-4 h-4 mr-2" />
              Démarrer un live
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Radio className="w-5 h-5 text-red-500" />
                Nouveau live
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="title">Titre du live</Label>
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="De quoi vas-tu parler ?"
                  className="premium-input"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description (optionnel)</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Décris ton live..."
                  className="premium-input min-h-[80px] resize-none"
                />
              </div>

              <div className="space-y-2">
                <Label>Catégorie</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map(cat => (
                      <SelectItem key={cat.value} value={cat.value}>
                        {cat.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="hashtags">Hashtags (séparés par des virgules)</Label>
                <Input
                  id="hashtags"
                  value={hashtags}
                  onChange={(e) => setHashtags(e.target.value)}
                  placeholder="gaming, fun, live"
                  className="premium-input"
                />
              </div>

              <Button
                onClick={handleStartLive}
                disabled={startLive.isPending}
                className="w-full bg-red-500 hover:bg-red-600"
              >
                {startLive.isPending ? 'Démarrage...' : '🔴 Démarrer le live'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </header>

      {/* Filters */}
      <div className="flex gap-2 mb-6 overflow-x-auto pb-2 -mx-4 px-4 scrollbar-hide">
        <button
          onClick={() => setFilter('all')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors',
            filter === 'all'
              ? 'bg-primary text-primary-foreground'
              : 'bg-secondary/50 text-muted-foreground hover:bg-secondary'
          )}
        >
          <TrendingUp className="w-4 h-4" />
          Pour toi
        </button>
        <button
          onClick={() => setFilter('following')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors',
            filter === 'following'
              ? 'bg-primary text-primary-foreground'
              : 'bg-secondary/50 text-muted-foreground hover:bg-secondary'
          )}
        >
          <Users className="w-4 h-4" />
          Abonnements
        </button>
      </div>

      {/* Lives grid — TikTok style */}
      {isLoading ? (
        <div className="grid grid-cols-2 gap-3">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="aspect-[9/16] rounded-2xl bg-secondary animate-pulse" />
          ))}
        </div>
      ) : filteredLives.length === 0 ? (
        <div className="text-center py-16">
          <Radio className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-xl font-semibold mb-2">Aucun live en cours</h2>
          <p className="text-muted-foreground mb-6">
            Sois le premier à démarrer un live !
          </p>
          <Button onClick={() => setIsDialogOpen(true)} className="pulse-button-gradient">
            <Plus className="w-4 h-4 mr-2" />
            Démarrer un live
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {filteredLives.map(live => (
            <LiveCard key={live.id} live={live} />
          ))}
        </div>
      )}
    </AppLayout>
  );
}
