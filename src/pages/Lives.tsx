import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radio, Plus, Users, TrendingUp, Sparkles } from 'lucide-react';
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
      <header className="flex items-center justify-between mb-5">
        <div>
          <h1 className="font-display text-xl font-bold flex items-center gap-2 tracking-tight">
            <Radio className="w-5 h-5 text-destructive" />
            Lives
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {filteredLives.length} live{filteredLives.length !== 1 ? 's' : ''} en cours
          </p>
        </div>

        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="premium-button h-9 px-4 text-xs rounded-xl">
              <Plus className="w-4 h-4 mr-1.5" />
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
      <div className="flex gap-2 mb-5 overflow-x-auto pb-2 -mx-4 px-4 scrollbar-hide">
        <button
          onClick={() => setFilter('all')}
          className={cn(
            'flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all duration-200',
            filter === 'all'
              ? 'bg-primary text-primary-foreground shadow-[var(--shadow-md)]'
              : 'bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground'
          )}
        >
          <TrendingUp className="w-3.5 h-3.5" />
          Pour toi
        </button>
        <button
          onClick={() => setFilter('following')}
          className={cn(
            'flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all duration-200',
            filter === 'following'
              ? 'bg-primary text-primary-foreground shadow-[var(--shadow-md)]'
              : 'bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground'
          )}
        >
          <Users className="w-3.5 h-3.5" />
          Abonnements
        </button>
      </div>

      {/* Zeus helper — always visible */}
      <button
        onClick={() => window.dispatchEvent(new CustomEvent('open-zeus', { detail: { action: 'live-help' } }))}
        className="w-full mb-4 p-3 rounded-2xl border border-primary/15 bg-accent/50 hover:bg-accent hover:border-primary/25 transition-all duration-300 text-left group"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--premium-gradient)' }}>
            <Sparkles className="w-4 h-4 text-primary-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-foreground">Zeus Live ⚡</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">Trouver un sujet · Générer un titre · Préparer ton live</p>
          </div>
        </div>
      </button>

      {/* Lives grid — TikTok style */}
      {isLoading ? (
        <div className="grid grid-cols-2 gap-3">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="aspect-[9/16] rounded-2xl bg-secondary animate-pulse" />
          ))}
        </div>
      ) : filteredLives.length === 0 ? (
        <div className="text-center py-16 space-y-5">
          <div className="w-16 h-16 rounded-2xl bg-secondary/40 flex items-center justify-center mx-auto">
            <Radio className="w-8 h-8 text-muted-foreground/50" />
          </div>
          <h2 className="text-lg font-semibold">Aucun live en cours</h2>
          <p className="text-sm text-muted-foreground max-w-xs mx-auto">
            Sois le premier à démarrer un live !
          </p>
          <Button onClick={() => setIsDialogOpen(true)} size="sm" className="premium-button h-10 px-5 text-xs rounded-xl">
            <Plus className="w-4 h-4 mr-1.5" />
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
