import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Search, Radio, ChevronUp } from 'lucide-react';
import { FeedLiveSwitch } from '@/components/live/FeedLiveSwitch';
import { LiveCategoryChips } from '@/components/live/LiveCategoryChips';
import { LivePlayerCard } from '@/components/live/LivePlayerCard';
import { ZeusLiveSuggestions } from '@/components/live/ZeusLiveSuggestions';
import { LiveSearchSheet } from '@/components/live/LiveSearchSheet';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';

interface LiveItem {
  id: string;
  title: string;
  thumbnail_url: string | null;
  is_active: boolean;
  viewer_count: number;
  total_views: number;
  category: string | null;
  user_id: string;
  recording_url: string | null;
  ended_at: string | null;
  started_at: string | null;
  host?: { name: string; avatar_url: string | null };
}

function useAllLivesForScreen() {
  return useQuery({
    queryKey: ['live-screen-all'],
    queryFn: async () => {
      const { data: activeLives } = await supabase
        .from('live_streams')
        .select('id, title, thumbnail_url, is_active, viewer_count, total_views, category, user_id, recording_url, started_at')
        .eq('is_active', true)
        .order('viewer_count', { ascending: false });

      const { data: replays } = await supabase
        .from('live_streams')
        .select('id, title, thumbnail_url, is_active, viewer_count, total_views, category, user_id, recording_url, ended_at, started_at')
        .eq('is_active', false)
        .not('ended_at', 'is', null)
        .order('ended_at', { ascending: false })
        .limit(20);

      const all = [
        ...(activeLives || []).map(l => ({ ...l, ended_at: null as string | null })),
        ...(replays || []).map(r => ({ ...r })),
      ];

      if (!all.length) return [];

      const hostIds = [...new Set(all.map(l => l.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', hostIds);

      const profileMap = new Map(
        (profiles || []).map(p => [p.user_id, { name: p.name, avatar_url: p.avatar_url }])
      );

      return all.map(l => ({ ...l, host: profileMap.get(l.user_id) })) as LiveItem[];
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });
}

export default function LiveScreen() {
  const navigate = useNavigate();
  const { data: allLives, isLoading } = useAllLivesForScreen();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [category, setCategory] = useState('pour-toi');
  const [searchOpen, setSearchOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Filter by category
  const filteredLives = useMemo(() => {
    if (!allLives) return [];
    if (category === 'pour-toi') return allLives;
    if (category === 'suivis') return allLives; // TODO: filter by followed
    return allLives.filter(l =>
      l.category?.toLowerCase() === category || 
      l.category?.toLowerCase().includes(category)
    );
  }, [allLives, category]);

  // Zeus suggestions (pick 3 random from other lives)
  const zeusSuggestions = useMemo(() => {
    if (!allLives || allLives.length < 2) return [];
    const current = filteredLives[currentIndex];
    return allLives
      .filter(l => l.id !== current?.id && l.is_active)
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
    if (!allLives) return [];
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
        {/* Top bar */}
        <div className="relative z-30 pt-[env(safe-area-inset-top,0px)]">
          <div className="flex items-center justify-between px-4 py-3">
            <button onClick={() => navigate(-1)} className="w-9 h-9 rounded-full bg-white/8 backdrop-blur-md flex items-center justify-center text-white/70">
              <ArrowLeft className="w-4.5 h-4.5" />
            </button>
            <FeedLiveSwitch active="live" onChange={handleSwitchTab} />
            <button onClick={() => setSearchOpen(true)} className="w-9 h-9 rounded-full bg-white/8 backdrop-blur-md flex items-center justify-center text-white/70">
              <Search className="w-4.5 h-4.5" />
            </button>
          </div>
          <LiveCategoryChips active={category} onChange={setCategory} />
        </div>

        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8">
          <div className="w-16 h-16 rounded-full flex items-center justify-center bg-white/5 border border-white/10">
            <Radio className="w-8 h-8 text-white/20" />
          </div>
          <h2 className="text-white font-semibold text-lg">Aucun live en cours</h2>
          <p className="text-white/40 text-sm text-center">Sois le premier à démarrer un live ou reviens plus tard !</p>
        </div>

        <LiveSearchSheet open={searchOpen} onClose={() => setSearchOpen(false)} creators={searchCreators} onSelect={handleZeusSelect} />
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
              <ArrowLeft className="w-4.5 h-4.5" />
            </button>
            <FeedLiveSwitch active="live" onChange={handleSwitchTab} />
            <button onClick={() => setSearchOpen(true)} className="w-9 h-9 rounded-full bg-white/8 backdrop-blur-md flex items-center justify-center text-white/70 hover:bg-white/15 transition-colors">
              <Search className="w-4.5 h-4.5" />
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
                index === 0 && item.is_active
                  ? 'Recommandé pour toi'
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
    </div>
  );
}
