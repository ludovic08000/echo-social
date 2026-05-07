import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Search, Radio, Plus, Eye, Clock, Sparkles, Video } from 'lucide-react';
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
import { prefetchLiveKitToken } from '@/lib/livekit';

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
    queryKey: ['live-screen-bundle', user?.id ?? 'guest'],
    queryFn: async () => {
      // ── Single batched RPC: actives + replays + profiles + ranks + follow ──
      const { data: bundle, error } = await supabase.rpc('live_feed_bundle' as any, {
        p_user_id: user?.id ?? null,
        p_active_limit: 80,
        p_replay_limit: 30,
      });

      if (error || !bundle) {
        return { lives: [] as LiveItem[], followingIds: [] as string[] };
      }

      const b = bundle as {
        active: any[];
        replays: any[];
        profiles: Array<{ user_id: string; name: string; avatar_url: string | null }>;
        ranks: Record<string, number>;
        following: string[];
      };

      const profileMap = new Map(b.profiles.map(p => [p.user_id, { name: p.name, avatar_url: p.avatar_url }]));
      const followingIds = b.following || [];
      const ranks = b.ranks || {};

      const all = [
        ...(b.active || []).map(l => ({ ...l, ended_at: null as string | null })),
        ...(b.replays || []),
      ];

      const hasRanks = Object.keys(ranks).length > 0;
      const lives = all.map(l => ({
        ...l,
        host: profileMap.get(l.user_id),
        _score: l.is_active
          ? (hasRanks
              ? (Number(ranks[l.id]) || 0)
              : calculateZeusScore(l, [], followingIds))
          : 0,
      })) as LiveItem[];

      lives.sort((a, b) => {
        if (a.is_active && !b.is_active) return -1;
        if (!a.is_active && b.is_active) return 1;
        return (b._score || 0) - (a._score || 0);
      });

      // ── Aggressive prefetch of top-6 thumbnails (CDN warm-up) ──
      try {
        if (typeof window !== 'undefined') {
          lives.slice(0, 6).forEach(l => {
            if (l.thumbnail_url) {
              const img = new Image();
              img.decoding = 'async';
              img.loading = 'eager' as any;
              img.src = l.thumbnail_url;
            }
            // Replay video first frame warm-up
            if (l.recording_url && !l.is_active) {
              const v = document.createElement('video');
              v.preload = 'metadata';
              v.src = l.recording_url + '#t=0.1';
            }
          });
        }
      } catch {}

      return { lives, followingIds };
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev, // keepPreviousData equivalent — instant UI
  });
}

// ─── Premium Mosaic Tile ─────────────────────────────────
function MosaicTile({ item, followingIds }: { item: LiveItem; isLarge?: boolean; followingIds: string[] }) {
  const navigate = useNavigate();

  const handleClick = () => {
    navigate(`/live/${item.id}?from=live`);
  };

  const hasVideo = !!item.recording_url && !item.is_active;

  return (
    <motion.button
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
      onClick={handleClick}
      onPointerEnter={() => { if (item.is_active) prefetchLiveKitToken(`live-${item.id}`); }}
      onFocus={() => { if (item.is_active) prefetchLiveKitToken(`live-${item.id}`); }}
      className="relative rounded-2xl overflow-hidden bg-black/60 group text-left w-full aspect-[3/4]"
    >
      {/* Background */}
      {hasVideo ? (
        <video
          src={`${item.recording_url!}#t=0.5`}
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
          muted loop autoPlay playsInline preload="auto"
          poster={item.thumbnail_url || undefined}
        />
      ) : item.thumbnail_url ? (
        <img
          src={item.thumbnail_url}
          alt={item.title}
          loading="lazy"
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
        />
      ) : (
        <div className={cn(
          "absolute inset-0 flex flex-col items-center justify-center gap-3",
          item.is_active
            ? "bg-gradient-to-br from-primary/20 via-black/80 to-accent/10"
            : "bg-gradient-to-br from-muted/10 via-black/90 to-black"
        )}>
          <div className="w-12 h-12 rounded-2xl bg-white/[0.06] backdrop-blur-sm flex items-center justify-center border border-white/[0.08]">
            {item.is_active ? (
              <Radio className="w-5 h-5 text-white/60 animate-pulse" />
            ) : (
              <Video className="w-5 h-5 text-white/30" />
            )}
          </div>
          <UserAvatar src={item.host?.avatar_url} alt={item.host?.name} size="sm" />
        </div>
      )}

      {/* Refined gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-black/30 pointer-events-none" />

      {/* Top badges — minimal, refined */}
      <div className="absolute top-2 left-2 right-2 flex items-center justify-between z-10">
        {item.is_active ? (
          <span className="px-2 py-0.5 rounded-lg text-[9px] font-bold text-white flex items-center gap-1 bg-destructive/90 backdrop-blur-sm shadow-lg">
            <Radio className="w-2.5 h-2.5 animate-pulse" />
            LIVE
          </span>
        ) : (
          <span className="px-2 py-0.5 rounded-lg bg-white/[0.08] backdrop-blur-md text-white/50 text-[8px] font-semibold tracking-wide uppercase">
            Replay
          </span>
        )}
        <span className="px-2 py-0.5 rounded-lg bg-black/40 backdrop-blur-md text-white/70 text-[9px] flex items-center gap-1 font-medium">
          <Eye className="w-2.5 h-2.5" />
          {item.is_active ? item.viewer_count : item.total_views}
        </span>
      </div>

      {/* Bottom info — elegant */}
      <div className="absolute bottom-0 left-0 right-0 p-2.5 z-10">
        <div className="flex items-center gap-2 mb-1">
          <div className="relative">
            <UserAvatar src={item.host?.avatar_url} alt={item.host?.name} size="xs" />
            {item.is_active && (
              <div className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-destructive border border-black" />
            )}
          </div>
          <span className="text-white text-[10px] font-semibold truncate">
            {item.host?.name || 'Utilisateur'}
          </span>
        </div>
        <p className="text-white/60 text-[9px] line-clamp-2 leading-snug font-medium">{item.title}</p>
        {!item.is_active && item.ended_at && (
          <p className="text-white/25 text-[8px] mt-0.5 font-medium">
            {formatDistanceToNow(new Date(item.ended_at), { addSuffix: true, locale: fr })}
          </p>
        )}
      </div>

      {/* Hover glow */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none rounded-2xl ring-1 ring-inset ring-white/[0.08]" />
    </motion.button>
  );
}

// ─── Zeus Creator Suggestions — Premium ────────────────────
function ZeusCreatorSuggestions({ lives, followingIds, onSelect }: {
  lives: LiveItem[];
  followingIds: string[];
  onSelect: (id: string) => void;
}) {
  const suggestions = useMemo(() => {
    const scored = [...lives]
      .sort((a, b) => {
        if (a.is_active && !b.is_active) return -1;
        if (!a.is_active && b.is_active) return 1;
        return (b._score || 0) - (a._score || 0);
      })
      .slice(0, 6)
      .map(l => ({
        id: l.id,
        title: l.title,
        hostName: l.host?.name || 'Utilisateur',
        hostAvatar: l.host?.avatar_url,
        viewerCount: l.is_active ? l.viewer_count : l.total_views,
        category: l.category || '',
        isFollowing: followingIds.includes(l.user_id),
        isLive: l.is_active,
      }));
    return scored;
  }, [lives, followingIds]);

  if (!suggestions.length) return null;

  return (
    <div className="px-4 pb-4">
      <div className="rounded-2xl overflow-hidden backdrop-blur-2xl border border-white/[0.06]"
        style={{
          background: 'linear-gradient(160deg, hsl(220 20% 12% / 0.95), hsl(240 15% 8% / 0.95))',
        }}
      >
        <div className="flex items-center gap-2 px-4 pt-3 pb-2">
          <div className="w-5 h-5 rounded-lg bg-primary/10 flex items-center justify-center">
            <Sparkles className="w-3 h-3 text-primary" />
          </div>
          <span className="text-[10px] font-bold text-white/40 uppercase tracking-[0.1em]">Recommandés par Zeus</span>
        </div>
        <div className="flex gap-2 overflow-x-auto scrollbar-none px-4 pb-3">
          {suggestions.map((s) => (
            <motion.button
              key={s.id}
              onClick={() => onSelect(s.id)}
              whileTap={{ scale: 0.96 }}
              className="flex items-center gap-3 shrink-0 px-3.5 py-2.5 rounded-xl bg-white/[0.03] hover:bg-white/[0.07] transition-all duration-300 border border-white/[0.04] hover:border-white/[0.1]"
            >
              <div className="relative">
                <UserAvatar src={s.hostAvatar} alt={s.hostName} size="sm" />
                {s.isLive && (
                  <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-destructive border-2 border-black" />
                )}
              </div>
              <div className="text-left">
                <p className="text-white/90 text-[11px] font-semibold truncate max-w-[90px]">{s.hostName}</p>
                <p className="text-white/30 text-[9px] font-medium">
                  {s.isLive ? `${s.viewerCount} viewers` : `${s.viewerCount} vues`}
                </p>
                {s.isFollowing && (
                  <p className="text-[8px] font-bold text-primary/70 uppercase tracking-wider mt-0.5">Ami</p>
                )}
              </div>
            </motion.button>
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
    navigate(`/live/${id}?from=live`);
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

  const darkBg = 'linear-gradient(170deg, hsl(230 20% 8%) 0%, hsl(220 15% 5%) 50%, hsl(240 12% 4%) 100%)';

  // Loading — premium skeleton
  if (isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ background: darkBg }}>
        <div className="flex flex-col items-center gap-5">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center bg-white/[0.04] border border-white/[0.06]">
            <Radio className="w-6 h-6 text-white/30 animate-pulse" />
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-white/30 text-xs font-medium tracking-wide">Chargement</span>
            <div className="w-20 h-0.5 rounded-full bg-white/[0.06] overflow-hidden">
              <motion.div 
                className="h-full bg-white/20 rounded-full"
                animate={{ x: ['-100%', '200%'] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  const activeLives = filteredLives.filter(l => l.is_active);
  const replayLives = filteredLives.filter(l => !l.is_active);

  return (
    <div className="fixed inset-0 overflow-hidden flex flex-col" style={{ background: darkBg }}>
      {/* Top bar — clean & minimal */}
      <div className="relative z-30 pt-[env(safe-area-inset-top,0px)]">
        <div className="flex items-center justify-between px-4 py-3">
          <motion.button 
            whileTap={{ scale: 0.9 }}
            onClick={() => navigate(-1)} 
            className="w-10 h-10 rounded-xl bg-white/[0.04] backdrop-blur-md flex items-center justify-center text-white/50 hover:bg-white/[0.08] hover:text-white/70 transition-all duration-300 border border-white/[0.04]"
          >
            <ArrowLeft className="w-5 h-5" />
          </motion.button>
          <FeedLiveSwitch active="live" onChange={handleSwitchTab} />
          <motion.button 
            whileTap={{ scale: 0.9 }}
            onClick={() => setSearchOpen(true)} 
            className="w-10 h-10 rounded-xl bg-white/[0.04] backdrop-blur-md flex items-center justify-center text-white/50 hover:bg-white/[0.08] hover:text-white/70 transition-all duration-300 border border-white/[0.04]"
          >
            <Search className="w-5 h-5" />
          </motion.button>
        </div>
        <LiveCategoryChips active={category} onChange={setCategory} />
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto scrollbar-none pb-24">
        {/* Zeus suggestions */}
        <ZeusCreatorSuggestions lives={allLives} followingIds={followingIds} onSelect={handleZeusSelect} />

        {/* === LIVE EN DIRECT === */}
        {activeLives.length > 0 && (
          <div className="mb-5">
            <div className="flex items-center gap-2.5 px-4 py-2.5">
              <div className="w-1.5 h-1.5 rounded-full animate-pulse bg-destructive" />
              <span className="text-white/70 text-[10px] font-bold uppercase tracking-[0.12em]">En direct</span>
              <span className="px-2 py-0.5 rounded-lg text-[9px] font-bold text-white/60 bg-white/[0.06]">
                {activeLives.length}
              </span>
            </div>
            <div className="px-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5">
              {activeLives.map((item, i) => (
                <motion.div
                  key={item.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: i * 0.05 }}
                >
                  <MosaicTile item={item} isLarge={false} followingIds={followingIds} />
                </motion.div>
              ))}
            </div>
          </div>
        )}

        {/* === REPLAYS === */}
        {replayLives.length > 0 && (
          <div>
            <div className="flex items-center gap-2.5 px-4 py-2.5">
              <Clock className="w-3 h-3 text-white/25" />
              <span className="text-white/35 text-[10px] font-bold uppercase tracking-[0.12em]">Replays</span>
            </div>
            <div className="px-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5">
              {replayLives.map((item, i) => (
                <motion.div
                  key={item.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: i * 0.03 }}
                >
                  <MosaicTile item={item} isLarge={false} followingIds={followingIds} />
                </motion.div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state — premium */}
        {!filteredLives.length && (
          <div className="flex flex-col items-center justify-center gap-5 px-8 pt-24">
            <div className="w-20 h-20 rounded-3xl flex items-center justify-center bg-white/[0.03] border border-white/[0.06]">
              <Radio className="w-9 h-9 text-white/15" />
            </div>
            <div className="text-center space-y-2">
              <h2 className="text-white/80 font-semibold text-base tracking-tight">Aucun live en cours</h2>
              <p className="text-white/25 text-sm font-medium">Sois le premier à démarrer un live</p>
            </div>
          </div>
        )}
      </div>

      {/* Start live FAB — premium */}
      <motion.button
        whileTap={{ scale: 0.9 }}
        whileHover={{ scale: 1.05 }}
        onClick={() => setStartDialogOpen(true)}
        className="absolute bottom-24 right-5 z-30 w-14 h-14 rounded-2xl flex items-center justify-center text-white border border-white/[0.1]"
        style={{
          background: 'linear-gradient(135deg, hsl(var(--primary)), hsl(var(--primary) / 0.7))',
          boxShadow: '0 8px 32px hsl(var(--primary) / 0.3), 0 0 0 1px hsl(var(--primary) / 0.1)',
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

// ─── Start Live Dialog — Premium ─────────────────
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
      <DialogContent className="sm:max-w-md bg-card border-border/50">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 text-base">
            <div className="w-8 h-8 rounded-xl bg-destructive/10 flex items-center justify-center">
              <Radio className="w-4 h-4 text-destructive" />
            </div>
            Nouveau live
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="live-title" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Titre du live</Label>
            <Input id="live-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="De quoi vas-tu parler ?" className="h-11" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="live-desc" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Description (optionnel)</Label>
            <Textarea id="live-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Décris ton live..." className="min-h-[80px] resize-none" />
          </div>
          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Catégorie</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CATEGORIES.map(cat => (
                  <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="live-tags" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Hashtags (séparés par des virgules)</Label>
            <Input id="live-tags" value={hashtags} onChange={(e) => setHashtags(e.target.value)} placeholder="gaming, fun, live" className="h-11" />
          </div>
          <Button onClick={onStart} disabled={isPending} className="w-full h-11 text-sm font-semibold">
            {isPending ? 'Démarrage...' : '🔴 Démarrer le live'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
