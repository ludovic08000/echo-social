import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Search, Radio, Plus, Eye, Play, Clock, Sparkles, Video } from 'lucide-react';
import { FeedLiveSwitch } from '@/components/live/FeedLiveSwitch';
import { LiveCategoryChips } from '@/components/live/LiveCategoryChips';
import { LiveSearchSheet } from '@/components/live/LiveSearchSheet';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UserAvatar } from '@/components/UserAvatar';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { useStartLive } from '@/hooks/useLiveStreams';
import { toast } from '@/hooks/use-toast';
import { motion, AnimatePresence } from 'framer-motion';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
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

// Zeus scoring algorithm
function calculateZeusScore(
  live: any,
  userInterests: string[],
  followingIds: string[]
): number {
  let score = 0;
  if (followingIds.includes(live.user_id)) score += 0.40;
  const viewerScore = Math.min(1, live.viewer_count / 1000);
  score += viewerScore * 0.30;
  const tags = [...(live.hashtags || []), live.category || ''].map((t: string) => t.toLowerCase());
  const matchCount = tags.filter((tag: string) =>
    userInterests.some(i => tag.includes(i.toLowerCase()))
  ).length;
  score += Math.min(1, matchCount / Math.max(1, tags.length)) * 0.20;
  if (live.started_at) {
    const minutesAgo = (Date.now() - new Date(live.started_at).getTime()) / 60000;
    if (minutesAgo < 10) score += 0.15;
  }
  score += Math.random() * 0.05;
  return Math.max(0, Math.min(1, score));
}

function useAllLivesForScreen() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['live-screen-all', user?.id],
    queryFn: async () => {
      const { data: activeLives } = await supabase
        .from('live_streams')
        .select('id, title, description, thumbnail_url, is_active, viewer_count, total_views, category, hashtags, user_id, recording_url, started_at')
        .eq('is_active', true)
        .order('viewer_count', { ascending: false });

      const { data: replays } = await supabase
        .from('live_streams')
        .select('id, title, description, thumbnail_url, is_active, viewer_count, total_views, category, hashtags, user_id, recording_url, ended_at, started_at')
        .eq('is_active', false)
        .not('ended_at', 'is', null)
        .order('ended_at', { ascending: false })
        .limit(30);

      const all = [
        ...(activeLives || []).map(l => ({ ...l, ended_at: null as string | null })),
        ...(replays || []).map(r => ({ ...r })),
      ];

      if (!all.length) return { lives: [] as LiveItem[], followingIds: [] as string[] };

      const hostIds = [...new Set(all.map(l => l.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', hostIds);

      const profileMap = new Map(
        (profiles || []).map(p => [p.user_id, { name: p.name, avatar_url: p.avatar_url }])
      );

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

      const lives = all.map(l => ({
        ...l,
        host: profileMap.get(l.user_id),
        _score: l.is_active ? calculateZeusScore(l, userInterests, followingIds) : 0,
      })) as LiveItem[];

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

// ─── Mosaic Tile ─────────────────────────────────
function MosaicTile({ item, isLarge, followingIds }: { item: LiveItem; isLarge?: boolean; followingIds: string[] }) {
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleMouseEnter = useCallback(() => {
    videoRef.current?.play().catch(() => {});
  }, []);

  const handleMouseLeave = useCallback(() => {
    const v = videoRef.current;
    if (v) { v.pause(); v.currentTime = 0; }
  }, []);

  const handleClick = () => {
    navigate(`/live/${item.id}?from=feed`);
  };

  const isFollowing = followingIds.includes(item.user_id);
  const hasVideo = !!item.recording_url && !item.is_active;

  return (
    <motion.button
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="relative rounded-lg overflow-hidden bg-black group text-left w-full aspect-[9/16]"
    >
      {/* Background */}
      {hasVideo ? (
        <video
          ref={videoRef}
          src={`${item.recording_url!}#t=0.5`}
          className="absolute inset-0 w-full h-full object-cover"
          muted loop playsInline preload="none"
          poster={item.thumbnail_url || undefined}
        />
      ) : item.thumbnail_url ? (
        <img
          src={item.thumbnail_url}
          alt={item.title}
          loading="lazy"
          className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
        />
      ) : (
        <div className={cn(
          "absolute inset-0 flex flex-col items-center justify-center gap-2",
          item.is_active
            ? "bg-gradient-to-br from-primary/30 via-accent/10 to-black"
            : "bg-gradient-to-br from-muted/20 via-background to-black"
        )}>
          <div className="w-8 h-8 rounded-full bg-white/10 backdrop-blur flex items-center justify-center">
            {item.is_active ? (
              <Radio className="w-4 h-4 text-white animate-pulse" />
            ) : (
              <Video className="w-4 h-4 text-white/60" />
            )}
          </div>
          <UserAvatar src={item.host?.avatar_url} alt={item.host?.name} size="xs" />
        </div>
      )}

      {/* Gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20 pointer-events-none" />

      {/* Top badge */}
      <div className="absolute top-1 left-1 right-1 flex items-center justify-between z-10">
        {item.is_active ? (
          <span className="px-1.5 py-0.5 rounded text-[8px] font-bold text-white flex items-center gap-0.5 shadow-lg"
            style={{ background: 'linear-gradient(135deg, hsl(var(--primary)), hsl(220 70% 55%))' }}>
            <Radio className="w-2 h-2 animate-pulse" />
            LIVE
          </span>
        ) : (
          <span className="px-1 py-0.5 rounded bg-black/50 backdrop-blur-sm text-white/60 text-[7px] font-medium">
            Replay
          </span>
        )}
        <span className="px-1 py-0.5 rounded bg-black/50 backdrop-blur-sm text-white/70 text-[7px] flex items-center gap-0.5">
          <Eye className="w-2 h-2" />
          {item.is_active ? item.viewer_count : item.total_views}
        </span>
      </div>

      {/* Bottom info — compact */}
      <div className="absolute bottom-0 left-0 right-0 p-1.5 z-10">
        <div className="flex items-center gap-1 mb-0.5">
          <UserAvatar src={item.host?.avatar_url} alt={item.host?.name} size="xs" />
          <span className="text-white text-[9px] font-semibold truncate">
            {item.host?.name || 'Utilisateur'}
          </span>
        </div>
        <p className="text-white/70 text-[8px] line-clamp-1 leading-tight">{item.title}</p>
      </div>

      {/* Hover play icon */}
      {hasVideo && (
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none">
          <div className="w-7 h-7 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center">
            <Play className="w-3.5 h-3.5 text-white ml-0.5" />
          </div>
        </div>
      )}
    </motion.button>
  );
}

// ─── Zeus Creator Suggestions ────────────────────
function ZeusCreatorSuggestions({ lives, followingIds, onSelect }: {
  lives: LiveItem[];
  followingIds: string[];
  onSelect: (id: string) => void;
}) {
  const suggestions = useMemo(() => {
    return lives
      .filter(l => l.is_active)
      .sort((a, b) => (b._score || 0) - (a._score || 0))
      .slice(0, 5)
      .map(l => ({
        id: l.id,
        title: l.title,
        hostName: l.host?.name || 'Utilisateur',
        hostAvatar: l.host?.avatar_url,
        viewerCount: l.viewer_count,
        category: l.category || '',
        isFollowing: followingIds.includes(l.user_id),
      }));
  }, [lives, followingIds]);

  if (!suggestions.length) return null;

  return (
    <div className="px-4 pb-3">
      <div className="rounded-2xl overflow-hidden backdrop-blur-xl border border-white/10"
        style={{
          background: 'linear-gradient(135deg, hsl(220 30% 15% / 0.9), hsl(260 20% 12% / 0.9))',
          boxShadow: '0 0 20px hsl(220 70% 55% / 0.08)',
        }}
      >
        <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5">
          <Sparkles className="w-3.5 h-3.5" style={{ color: 'hsl(190 80% 50%)' }} />
          <span className="text-[11px] font-semibold text-white/60">Zeus recommande</span>
        </div>
        <div className="flex gap-2.5 overflow-x-auto scrollbar-none px-3 pb-2.5">
          {suggestions.map((s) => (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              className="flex items-center gap-2.5 shrink-0 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors border border-white/5"
            >
              <div className="relative">
                <UserAvatar src={s.hostAvatar} alt={s.hostName} size="sm" />
                <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border border-black"
                  style={{ background: 'hsl(var(--primary))' }} />
              </div>
              <div className="text-left">
                <p className="text-white text-[11px] font-medium truncate max-w-[90px]">{s.hostName}</p>
                <p className="text-white/40 text-[9px]">{s.viewerCount} viewers</p>
                {s.isFollowing && (
                  <p className="text-[8px] font-semibold" style={{ color: 'hsl(190 80% 50%)' }}>Ami</p>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main Screen ──────────────────────────────────
export default function LiveScreen() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data, isLoading } = useAllLivesForScreen();
  const allLives = data?.lives || [];
  const followingIds = data?.followingIds || [];

  const [category, setCategory] = useState('pour-toi');
  const [searchOpen, setSearchOpen] = useState(false);
  const [startDialogOpen, setStartDialogOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newCategory, setNewCategory] = useState('general');
  const [newHashtags, setNewHashtags] = useState('');
  const startLive = useStartLive();

  // Filter by category
  const filteredLives = useMemo(() => {
    if (!allLives.length) return [];
    if (category === 'pour-toi') return allLives;
    if (category === 'suivis') return allLives.filter(l => followingIds.includes(l.user_id));
    const categoryMap: Record<string, string[]> = {
      'gaming': ['gaming'],
      'lifestyle': ['lifestyle'],
      'musique': ['music', 'musique'],
      'tech': ['tech', 'education'],
      'sport': ['sports', 'sport'],
      'auto': ['auto'],
    };
    const matches = categoryMap[category] || [category];
    return allLives.filter(l => matches.some(m => l.category?.toLowerCase().includes(m)));
  }, [allLives, category, followingIds]);

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

  const handleSwitchTab = (tab: 'feed' | 'live') => {
    if (tab === 'feed') navigate('/feed');
  };

  const handleZeusSelect = (id: string) => {
    navigate(`/live/${id}?from=feed`);
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

  // Determine which tiles are "large" (first active live, every 5th item for visual interest)
  const tileLayout = useMemo(() => {
    return filteredLives.map((item, i) => ({
      item,
      isLarge: i === 0 || (item.is_active && i < 4),
    }));
  }, [filteredLives]);

  const darkBg = 'linear-gradient(160deg, hsl(260 30% 12%) 0%, hsl(220 25% 10%) 50%, hsl(190 20% 8%) 100%)';

  // Loading
  if (isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ background: darkBg }}>
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, hsl(260 70% 55%), hsl(220 70% 55%), hsl(190 80% 50%))', boxShadow: '0 0 30px hsl(260 70% 55% / 0.4)' }}>
            <Radio className="w-6 h-6 text-white animate-pulse" />
          </div>
          <span className="text-white/50 text-sm">Chargement des lives...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 overflow-hidden flex flex-col" style={{ background: darkBg }}>
      {/* Top bar */}
      <div className="relative z-30 pt-[env(safe-area-inset-top,0px)]">
        <div className="flex items-center justify-between px-4 py-3">
          <button onClick={() => navigate(-1)} className="w-9 h-9 rounded-full bg-white/8 backdrop-blur-md flex items-center justify-center text-white/70 hover:bg-white/15 transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <FeedLiveSwitch active="live" onChange={handleSwitchTab} />
          <button onClick={() => setSearchOpen(true)} className="w-9 h-9 rounded-full bg-white/8 backdrop-blur-md flex items-center justify-center text-white/70 hover:bg-white/15 transition-colors">
            <Search className="w-5 h-5" />
          </button>
        </div>
        <LiveCategoryChips active={category} onChange={setCategory} />
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto scrollbar-none pb-24">
        {/* Zeus suggestions */}
        <ZeusCreatorSuggestions lives={allLives} followingIds={followingIds} onSelect={handleZeusSelect} />

        {/* Empty state */}
        {!filteredLives.length && (
          <div className="flex flex-col items-center justify-center gap-4 px-8 pt-20">
            <div className="w-16 h-16 rounded-full flex items-center justify-center bg-white/5 border border-white/10">
              <Radio className="w-8 h-8 text-white/20" />
            </div>
            <h2 className="text-white font-semibold text-lg">Aucun live en cours</h2>
            <p className="text-white/40 text-sm text-center">Sois le premier à démarrer un live !</p>
          </div>
        )}

        {/* Mosaic grid — 3 columns like TikTok */}
        {filteredLives.length > 0 && (
          <div className="px-1 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-[2px] auto-rows-auto">
            {tileLayout.map(({ item, isLarge }) => (
              <MosaicTile
                key={item.id}
                item={item}
                isLarge={false}
                followingIds={followingIds}
              />
            ))}
          </div>
        )}
      </div>

      {/* Start live FAB */}
      <motion.button
        whileTap={{ scale: 0.9 }}
        onClick={() => setStartDialogOpen(true)}
        className="absolute bottom-24 right-4 z-30 w-14 h-14 rounded-full flex items-center justify-center text-white shadow-lg"
        style={{
          background: 'linear-gradient(135deg, hsl(260 70% 55%), hsl(220 70% 55%))',
          boxShadow: '0 4px 20px hsl(260 70% 55% / 0.5)',
        }}
      >
        <Plus className="w-6 h-6" />
      </motion.button>

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
            <Input id="live-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="De quoi vas-tu parler ?" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="live-desc">Description (optionnel)</Label>
            <Textarea id="live-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Décris ton live..." className="min-h-[80px] resize-none" />
          </div>
          <div className="space-y-2">
            <Label>Catégorie</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CATEGORIES.map(cat => (
                  <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="live-tags">Hashtags (séparés par des virgules)</Label>
            <Input id="live-tags" value={hashtags} onChange={(e) => setHashtags(e.target.value)} placeholder="gaming, fun, live" />
          </div>
          <Button onClick={onStart} disabled={isPending} className="w-full">
            {isPending ? 'Démarrage...' : '🔴 Démarrer le live'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
