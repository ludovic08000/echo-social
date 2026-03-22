import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Search, Radio, ChevronUp, Plus } from 'lucide-react';
import { FeedLiveSwitch } from '@/components/live/FeedLiveSwitch';
import { LiveCategoryChips } from '@/components/live/LiveCategoryChips';
import { LivePlayerCard } from '@/components/live/LivePlayerCard';
import { ZeusLiveSuggestions } from '@/components/live/ZeusLiveSuggestions';
import { LiveSearchSheet } from '@/components/live/LiveSearchSheet';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { useStartLive } from '@/hooks/useLiveStreams';
import { toast } from '@/hooks/use-toast';
import { motion } from 'framer-motion';

const CATEGORIES = [
  { value: 'general', label: 'Général' },
  { value: 'gaming', label: 'Gaming' },
  { value: 'music', label: 'Musique' },
  { value: 'sports', label: 'Sports' },
  { value: 'lifestyle', label: 'Lifestyle' },
  { value: 'education', label: 'Éducation' },
  { value: 'art', label: 'Art & Créatif' },
  { value: 'talk', label: 'Discussion' },
  { value: 'tech', label: 'Tech' },
  { value: 'auto', label: 'Auto' },
];

interface LiveItem {
  id: string;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  is_active: boolean;
  viewer_count: number;
  total_views: number;
  category: string | null;
  hashtags: string[];
  user_id: string;
  recording_url: string | null;
  ended_at: string | null;
  started_at: string | null;
  host?: { name: string; avatar_url: string | null };
  _score?: number;
}

// Zeus-powered scoring algorithm for lives
function calculateZeusScore(
  live: any,
  userInterests: string[],
  followingIds: string[]
): number {
  let score = 0;

  // 1. Following boost (highest priority)
  if (followingIds.includes(live.user_id)) {
    score += 0.40;
  }

  // 2. Viewer count (popularity signal)
  const viewerScore = Math.min(1, live.viewer_count / 1000);
  score += viewerScore * 0.30;

  // 3. Interest matching via hashtags/category
  const tags = [...(live.hashtags || []), live.category || ''].map((t: string) => t.toLowerCase());
  const matchCount = tags.filter((tag: string) =>
    userInterests.some(i => tag.includes(i.toLowerCase()))
  ).length;
  score += Math.min(1, matchCount / Math.max(1, tags.length)) * 0.20;

  // 4. Freshness boost (started < 10 min ago)
  if (live.started_at) {
    const minutesAgo = (Date.now() - new Date(live.started_at).getTime()) / 60000;
    if (minutesAgo < 10) score += 0.15;
  }

  // 5. Slight randomization
  score += Math.random() * 0.05;

  return Math.max(0, Math.min(1, score));
}

function useAllLivesForScreen() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['live-screen-all', user?.id],
    queryFn: async () => {
      // Fetch active lives
      const { data: activeLives } = await supabase
        .from('live_streams')
        .select('id, title, description, thumbnail_url, is_active, viewer_count, total_views, category, hashtags, user_id, recording_url, started_at')
        .eq('is_active', true)
        .order('viewer_count', { ascending: false });

      // Fetch recent replays
      const { data: replays } = await supabase
        .from('live_streams')
        .select('id, title, description, thumbnail_url, is_active, viewer_count, total_views, category, hashtags, user_id, recording_url, ended_at, started_at')
        .eq('is_active', false)
        .not('ended_at', 'is', null)
        .order('ended_at', { ascending: false })
        .limit(20);

      const all = [
        ...(activeLives || []).map(l => ({ ...l, ended_at: null as string | null })),
        ...(replays || []).map(r => ({ ...r })),
      ];

      if (!all.length) return { lives: [] as LiveItem[], followingIds: [] as string[] };

      // Fetch host profiles
      const hostIds = [...new Set(all.map(l => l.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', hostIds);

      const profileMap = new Map(
        (profiles || []).map(p => [p.user_id, { name: p.name, avatar_url: p.avatar_url }])
      );

      // Fetch user interests & friendships for Zeus scoring
      let userInterests: string[] = [];
      let followingIds: string[] = [];

      if (user) {
        const { data: interests } = await supabase
          .from('user_interests')
          .select('interest_value')
          .eq('user_id', user.id);
        userInterests = (interests || []).map(i => i.interest_value);

        const { data: friendships } = await supabase
          .from('friendships')
          .select('requester_id, addressee_id')
          .eq('status', 'accepted')
          .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);

        followingIds = (friendships || []).map(f =>
          f.requester_id === user.id ? f.addressee_id : f.requester_id
        );
      }

      // Score and sort active lives with Zeus algorithm
      const lives = all.map(l => ({
        ...l,
        host: profileMap.get(l.user_id),
        _score: l.is_active ? calculateZeusScore(l, userInterests, followingIds) : 0,
      })) as LiveItem[];

      // Sort: active first (by score), then replays
      lives.sort((a, b) => {
        if (a.is_active && !b.is_active) return -1;
        if (!a.is_active && b.is_active) return 1;
        return (b._score || 0) - (a._score || 0);
      });

      return { lives, followingIds };
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });
}

export default function LiveScreen() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data, isLoading } = useAllLivesForScreen();
  const allLives = data?.lives || [];
  const followingIds = data?.followingIds || [];

  const [currentIndex, setCurrentIndex] = useState(0);
  const [category, setCategory] = useState('pour-toi');
  const [searchOpen, setSearchOpen] = useState(false);
  const [startDialogOpen, setStartDialogOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newCategory, setNewCategory] = useState('general');
  const [newHashtags, setNewHashtags] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const startLive = useStartLive();

  // Filter by category with real "Suivis" filter
  const filteredLives = useMemo(() => {
    if (!allLives.length) return [];
    if (category === 'pour-toi') return allLives;
    if (category === 'suivis') {
      return allLives.filter(l => followingIds.includes(l.user_id));
    }
    // Map chip IDs to category values
    const categoryMap: Record<string, string[]> = {
      'gaming': ['gaming'],
      'lifestyle': ['lifestyle'],
      'musique': ['music', 'musique'],
      'tech': ['tech', 'education'],
      'sport': ['sports', 'sport'],
      'auto': ['auto'],
    };
    const matches = categoryMap[category] || [category];
    return allLives.filter(l =>
      matches.some(m => l.category?.toLowerCase().includes(m))
    );
  }, [allLives, category, followingIds]);

  // Zeus suggestions: top scored lives the user hasn't seen yet
  const zeusSuggestions = useMemo(() => {
    if (!allLives.length) return [];
    const current = filteredLives[currentIndex];
    return allLives
      .filter(l => l.id !== current?.id && l.is_active)
      .sort((a, b) => (b._score || 0) - (a._score || 0))
      .slice(0, 3)
      .map(l => ({
        id: l.id,
        title: l.title,
        hostName: l.host?.name || 'Utilisateur',
        hostAvatar: l.host?.avatar_url,
        viewerCount: l.viewer_count,
        category: l.category || 'general',
      }));
  }, [allLives, filteredLives, currentIndex]);

  // Search creators
  const searchCreators = useMemo(() => {
    if (!allLives.length) return [];
    return allLives.map(l => ({
      id: l.id,
      name: l.host?.name || 'Utilisateur',
      avatar_url: l.host?.avatar_url,
      viewerCount: l.is_active ? l.viewer_count : l.total_views,
      category: l.category || 'general',
      isLive: l.is_active,
    }));
  }, [allLives]);

  // Snap scroll handler
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const newIndex = Math.round(el.scrollTop / el.clientHeight);
    if (newIndex !== currentIndex && newIndex >= 0 && newIndex < filteredLives.length) {
      setCurrentIndex(newIndex);
    }
  }, [currentIndex, filteredLives.length]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Reset index when category changes
  useEffect(() => {
    setCurrentIndex(0);
    if (containerRef.current) containerRef.current.scrollTop = 0;
  }, [category]);

  const handleSwitchTab = (tab: 'feed' | 'live') => {
    if (tab === 'feed') navigate('/feed');
  };

  const handleZeusSelect = (id: string) => {
    const idx = filteredLives.findIndex(l => l.id === id);
    if (idx >= 0 && containerRef.current) {
      containerRef.current.scrollTo({ top: idx * containerRef.current.clientHeight, behavior: 'smooth' });
    }
  };

  const handleStartLive = async () => {
    if (!newTitle.trim()) {
      toast({ title: 'Donne un titre à ton live', variant: 'destructive' });
      return;
    }
    try {
      const data = await startLive.mutateAsync({
        title: newTitle,
        description: newDesc,
        category: newCategory,
        hashtags: newHashtags.split(',').map(t => t.trim()).filter(Boolean),
      });
      setStartDialogOpen(false);
      setNewTitle('');
      setNewDesc('');
      setNewCategory('general');
      setNewHashtags('');
      toast({ title: 'Live démarré ! 🔴' });
      if (data?.id) navigate(`/live/${data.id}`);
    } catch {
      toast({ title: 'Erreur lors du démarrage', variant: 'destructive' });
    }
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{
        background: 'linear-gradient(160deg, hsl(260 30% 12%) 0%, hsl(220 25% 10%) 50%, hsl(190 20% 8%) 100%)',
      }}>
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{
            background: 'linear-gradient(135deg, hsl(260 70% 55%), hsl(220 70% 55%), hsl(190 80% 50%))',
            boxShadow: '0 0 30px hsl(260 70% 55% / 0.4)',
          }}>
            <Radio className="w-6 h-6 text-white animate-pulse" />
          </div>
          <span className="text-white/50 text-sm">Chargement des lives...</span>
        </div>
      </div>
    );
  }

  // Empty state
  if (!filteredLives.length) {
    return (
      <div className="fixed inset-0 flex flex-col" style={{
        background: 'linear-gradient(160deg, hsl(260 30% 12%) 0%, hsl(220 25% 10%) 50%, hsl(190 20% 8%) 100%)',
      }}>
        <div className="relative z-30 pt-[env(safe-area-inset-top,0px)]">
          <div className="flex items-center justify-between px-4 py-3">
            <button onClick={() => navigate(-1)} className="w-9 h-9 rounded-full bg-white/8 backdrop-blur-md flex items-center justify-center text-white/70">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <FeedLiveSwitch active="live" onChange={handleSwitchTab} />
            <button onClick={() => setSearchOpen(true)} className="w-9 h-9 rounded-full bg-white/8 backdrop-blur-md flex items-center justify-center text-white/70">
              <Search className="w-5 h-5" />
            </button>
          </div>
          <LiveCategoryChips active={category} onChange={setCategory} />
        </div>

        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8">
          <div className="w-16 h-16 rounded-full flex items-center justify-center bg-white/5 border border-white/10">
            <Radio className="w-8 h-8 text-white/20" />
          </div>
          <h2 className="text-white font-semibold text-lg">Aucun live en cours</h2>
          <p className="text-white/40 text-sm text-center">Sois le premier à démarrer un live !</p>
          <StartLiveButton onClick={() => setStartDialogOpen(true)} />
        </div>

        <LiveSearchSheet open={searchOpen} onClose={() => setSearchOpen(false)} creators={searchCreators} onSelect={handleZeusSelect} />
        <StartLiveDialog
          open={startDialogOpen}
          onOpenChange={setStartDialogOpen}
          title={newTitle}
          setTitle={setNewTitle}
          description={newDesc}
          setDescription={setNewDesc}
          category={newCategory}
          setCategory={setNewCategory}
          hashtags={newHashtags}
          setHashtags={setNewHashtags}
          onStart={handleStartLive}
          isPending={startLive.isPending}
        />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black overflow-hidden">
      {/* Top bar — fixed overlay */}
      <div className="absolute top-0 left-0 right-0 z-30 pointer-events-none">
        <div className="bg-gradient-to-b from-black/70 via-black/30 to-transparent pt-[env(safe-area-inset-top,0px)]">
          <div className="flex items-center justify-between px-4 py-3 pointer-events-auto">
            <button onClick={() => navigate(-1)} className="w-9 h-9 rounded-full bg-white/8 backdrop-blur-md flex items-center justify-center text-white/70 hover:bg-white/15 transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <FeedLiveSwitch active="live" onChange={handleSwitchTab} />
            <button onClick={() => setSearchOpen(true)} className="w-9 h-9 rounded-full bg-white/8 backdrop-blur-md flex items-center justify-center text-white/70 hover:bg-white/15 transition-colors">
              <Search className="w-5 h-5" />
            </button>
          </div>
          <div className="pointer-events-auto">
            <LiveCategoryChips active={category} onChange={setCategory} />
          </div>
          {/* Zeus suggestions */}
          {zeusSuggestions.length > 0 && currentIndex === 0 && (
            <div className="pointer-events-auto">
              <ZeusLiveSuggestions suggestions={zeusSuggestions} onSelect={handleZeusSelect} />
            </div>
          )}
        </div>
      </div>

      {/* Start live FAB */}
      <motion.button
        whileTap={{ scale: 0.9 }}
        onClick={() => setStartDialogOpen(true)}
        className="absolute bottom-24 right-4 z-30 w-12 h-12 rounded-full flex items-center justify-center text-white shadow-lg"
        style={{
          background: 'linear-gradient(135deg, hsl(260 70% 55%), hsl(220 70% 55%))',
          boxShadow: '0 4px 20px hsl(260 70% 55% / 0.5)',
        }}
      >
        <Plus className="w-5 h-5" />
      </motion.button>

      {/* Vertical snap scroll container */}
      <div
        ref={containerRef}
        className="h-full overflow-y-auto snap-y snap-mandatory scrollbar-none"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        {filteredLives.map((item, index) => (
          <div key={item.id} className="w-full h-screen snap-start snap-always">
            <LivePlayerCard
              item={item}
              isVisible={index === currentIndex}
              zeusReason={
                item.is_active && followingIds.includes(item.user_id)
                  ? 'Ami en direct'
                  : item.is_active && (item._score || 0) > 0.6
                  ? 'Recommandé par Zeus'
                  : item.is_active && item.viewer_count > 100
                  ? 'Tendance en ce moment'
                  : undefined
              }
            />
          </div>
        ))}
      </div>

      {/* Scroll hint */}
      {currentIndex < filteredLives.length - 1 && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
          <ChevronUp className="w-5 h-5 text-white/20 animate-bounce" />
        </div>
      )}

      {/* Search sheet */}
      <LiveSearchSheet open={searchOpen} onClose={() => setSearchOpen(false)} creators={searchCreators} onSelect={handleZeusSelect} />

      {/* Start live dialog */}
      <StartLiveDialog
        open={startDialogOpen}
        onOpenChange={setStartDialogOpen}
        title={newTitle}
        setTitle={setNewTitle}
        description={newDesc}
        setDescription={setNewDesc}
        category={newCategory}
        setCategory={setNewCategory}
        hashtags={newHashtags}
        setHashtags={setNewHashtags}
        onStart={handleStartLive}
        isPending={startLive.isPending}
      />
    </div>
  );
}

// ─── Start Live Button ───────────────────────────
function StartLiveButton({ onClick }: { onClick: () => void }) {
  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      onClick={onClick}
      className="flex items-center gap-2 px-6 py-3 rounded-xl text-white font-semibold text-sm"
      style={{
        background: 'linear-gradient(135deg, hsl(260 70% 55%), hsl(220 70% 55%), hsl(190 80% 50%))',
        boxShadow: '0 4px 20px hsl(260 70% 55% / 0.4)',
      }}
    >
      <Radio className="w-4 h-4" />
      Démarrer un live
    </motion.button>
  );
}

// ─── Start Live Dialog ───────────────────────────
function StartLiveDialog({
  open, onOpenChange,
  title, setTitle,
  description, setDescription,
  category, setCategory,
  hashtags, setHashtags,
  onStart, isPending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  setTitle: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  category: string;
  setCategory: (v: string) => void;
  hashtags: string;
  setHashtags: (v: string) => void;
  onStart: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Radio className="w-5 h-5 text-primary" />
            Nouveau live
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="live-title">Titre du live</Label>
            <Input
              id="live-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="De quoi vas-tu parler ?"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="live-desc">Description (optionnel)</Label>
            <Textarea
              id="live-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Décris ton live..."
              className="min-h-[80px] resize-none"
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
                  <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="live-tags">Hashtags (séparés par des virgules)</Label>
            <Input
              id="live-tags"
              value={hashtags}
              onChange={(e) => setHashtags(e.target.value)}
              placeholder="gaming, fun, live"
            />
          </div>
          <Button onClick={onStart} disabled={isPending} className="w-full">
            {isPending ? 'Démarrage...' : '🔴 Démarrer le live'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
