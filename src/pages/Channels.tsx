import { useState } from 'react';
import { Plus, Tv, Search, Users, Play } from 'lucide-react';
import { AppLayout } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { UserAvatar } from '@/components/UserAvatar';
import { useAuth } from '@/lib/auth';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';

const CHANNEL_THEMES = [
  { value: 'gaming', label: '🎮 Gaming', color: 'bg-purple-500/20 text-purple-400' },
  { value: 'music', label: '🎵 Musique', color: 'bg-pink-500/20 text-pink-400' },
  { value: 'sport', label: '⚽ Sport', color: 'bg-green-500/20 text-green-400' },
  { value: 'news', label: '📰 Actualités', color: 'bg-blue-500/20 text-blue-400' },
  { value: 'education', label: '📚 Éducation', color: 'bg-yellow-500/20 text-yellow-400' },
  { value: 'cooking', label: '🍳 Cuisine', color: 'bg-orange-500/20 text-orange-400' },
  { value: 'tech', label: '💻 Tech', color: 'bg-cyan-500/20 text-cyan-400' },
  { value: 'art', label: '🎨 Art & Créativité', color: 'bg-rose-500/20 text-rose-400' },
  { value: 'lifestyle', label: '✨ Lifestyle', color: 'bg-amber-500/20 text-amber-400' },
  { value: 'comedy', label: '😂 Humour', color: 'bg-lime-500/20 text-lime-400' },
  { value: 'general', label: '📺 Général', color: 'bg-secondary text-foreground' },
];

function getThemeInfo(theme: string) {
  return CHANNEL_THEMES.find(t => t.value === theme) || CHANNEL_THEMES[CHANNEL_THEMES.length - 1];
}

export default function Channels() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [filterTheme, setFilterTheme] = useState<string>('all');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newChannel, setNewChannel] = useState({ name: '', description: '', theme: 'general' });

  const { data: channels, isLoading } = useQuery({
    queryKey: ['tv-channels'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tv_channels')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: channelProfiles } = useQuery({
    queryKey: ['tv-channel-profiles', channels?.map(c => c.user_id)],
    queryFn: async () => {
      if (!channels || channels.length === 0) return {};
      const userIds = [...new Set(channels.map(c => c.user_id))];
      const { data } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', userIds);
      const map: Record<string, { name: string; avatar_url: string | null }> = {};
      data?.forEach(p => { map[p.user_id] = p; });
      return map;
    },
    enabled: !!channels && channels.length > 0,
  });

  const createChannel = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error('Non connecté');
      const { error } = await supabase.from('tv_channels').insert({
        user_id: user.id,
        name: newChannel.name.trim(),
        description: newChannel.description.trim() || null,
        theme: newChannel.theme,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tv-channels'] });
      setIsCreateOpen(false);
      setNewChannel({ name: '', description: '', theme: 'general' });
      toast({ title: 'Canal créé ! 📺' });
    },
    onError: () => toast({ title: 'Erreur', variant: 'destructive' }),
  });

  const filtered = channels?.filter(ch => {
    const matchSearch = !search || ch.name.toLowerCase().includes(search.toLowerCase());
    const matchTheme = filterTheme === 'all' || ch.theme === filterTheme;
    return matchSearch && matchTheme;
  });

  return (
    <AppLayout>
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Tv className="w-7 h-7 text-primary" />
            <h1 className="text-2xl font-bold">Canaux TV</h1>
          </div>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="w-4 h-4" /> Créer un canal
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Créer un canal TV</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label>Nom du canal</Label>
                  <Input
                    value={newChannel.name}
                    onChange={e => setNewChannel(p => ({ ...p, name: e.target.value }))}
                    placeholder="Mon super canal"
                    maxLength={60}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Thème</Label>
                  <Select value={newChannel.theme} onValueChange={v => setNewChannel(p => ({ ...p, theme: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CHANNEL_THEMES.map(t => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Description (optionnel)</Label>
                  <Textarea
                    value={newChannel.description}
                    onChange={e => setNewChannel(p => ({ ...p, description: e.target.value }))}
                    placeholder="De quoi parle votre canal..."
                    maxLength={300}
                    rows={3}
                  />
                </div>
                <Button
                  onClick={() => createChannel.mutate()}
                  disabled={!newChannel.name.trim() || createChannel.isPending}
                  className="w-full"
                >
                  {createChannel.isPending ? 'Création...' : 'Créer le canal'}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Filters */}
        <div className="flex gap-3 flex-col sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Rechercher un canal..."
              className="pl-10"
            />
          </div>
          <Select value={filterTheme} onValueChange={setFilterTheme}>
            <SelectTrigger className="w-full sm:w-48"><SelectValue placeholder="Thème" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tous les thèmes</SelectItem>
              {CHANNEL_THEMES.map(t => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Channels grid */}
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-40 rounded-2xl bg-card animate-pulse" />
            ))}
          </div>
        ) : filtered && filtered.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {filtered.map(channel => {
              const theme = getThemeInfo(channel.theme);
              const profile = channelProfiles?.[channel.user_id];
              return (
                <div
                  key={channel.id}
                  className="group relative bg-card border border-border/50 rounded-2xl p-5 hover:border-primary/30 transition-all cursor-pointer"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                        <Tv className="w-6 h-6 text-primary" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-foreground">{channel.name}</h3>
                        <div className="flex items-center gap-2 mt-0.5">
                          <UserAvatar src={profile?.avatar_url} alt={profile?.name} size="xs" />
                          <span className="text-xs text-muted-foreground">{profile?.name || 'Utilisateur'}</span>
                        </div>
                      </div>
                    </div>
                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${theme.color}`}>
                      {theme.label}
                    </span>
                  </div>

                  {channel.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2 mb-3">{channel.description}</p>
                  )}

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Users className="w-3.5 h-3.5" />
                      <span>{channel.viewer_count} spectateurs</span>
                    </div>
                    <Button size="sm" variant="ghost" className="gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Play className="w-3.5 h-3.5" /> Regarder
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-16">
            <Tv className="w-16 h-16 mx-auto mb-4 text-muted-foreground/30" />
            <p className="text-lg font-medium text-muted-foreground">Aucun canal trouvé</p>
            <p className="text-sm text-muted-foreground/70 mt-1">Soyez le premier à créer un canal TV !</p>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
