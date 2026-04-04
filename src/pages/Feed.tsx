import React, { useEffect, useRef, useCallback, useState, useMemo, lazy, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useVirtualizer } from '@tanstack/react-virtual';
import { usePosts } from '@/hooks/usePosts';
import { AppLayout } from '@/components/AppLayout';
import { CreatePost } from '@/components/CreatePost';
import { PostCard } from '@/components/PostCard';
import { StoriesBar } from '@/components/StoriesBar';
import { useNavigate } from 'react-router-dom';

import { FeedRightSidebar } from '@/components/feed/FeedRightSidebar';
import { FeedLiveSection } from '@/components/feed/FeedLiveSection';
import { SponsoredPostCard } from '@/components/feed/SponsoredPostCard';
import { Coffee, X, Sparkles, Lock, Shield } from 'lucide-react';
import { FeedZeusCard } from '@/components/feed/FeedZeusCard';
import { trackMinute, getTodayMinutes, getSessionMinutes } from '@/lib/feedAlgorithm';
import { Button } from '@/components/ui/button';
import { useActiveAds } from '@/hooks/useAdCampaigns';
import { useCustomBackground } from '@/hooks/useCustomBackground';
import { useFeedCustomization } from '@/hooks/useFeedCustomization';
import { useParentalGate } from '@/components/ParentalGate';
import { useIsMobile } from '@/hooks/use-mobile';
import { useFeedScrollMemory } from '@/hooks/useFeedScrollMemory';
import { useFeedPerformance } from '@/hooks/useFeedPerformance';
import { useUXMode } from '@/hooks/useUXMode';
import { FlowUniversalSearch } from '@/components/flow/FlowUniversalSearch';
import { FlowDashboard } from '@/components/flow/FlowDashboard';

// Lazy-load heavy injection components — only loaded when scrolled into view
const FriendSuggestions = lazy(() => import('@/components/feed/FriendSuggestions').then(m => ({ default: m.FriendSuggestions })));
const FriendSuggestionsByCity = lazy(() => import('@/components/feed/FriendSuggestionsByCity').then(m => ({ default: m.FriendSuggestionsByCity })));
const FeedReelsSection = lazy(() => import('@/components/feed/FeedReelsSection').then(m => ({ default: m.FeedReelsSection })));
const FeedMarketplaceSection = lazy(() => import('@/components/feed/FeedMarketplaceSection').then(m => ({ default: m.FeedMarketplaceSection })));
const FeedMediaSection = lazy(() => import('@/components/feed/FeedMediaSection').then(m => ({ default: m.FeedMediaSection })));

const INJECTION_MAP: Record<number, 'suggestions' | 'suggestions_city' | 'reels' | 'media' | 'marketplace'> = {
  2: 'marketplace',
  4: 'suggestions_city',
  6: 'suggestions',
  9: 'media',
  12: 'marketplace',
  15: 'reels',
  23: 'marketplace',
  27: 'suggestions',
};

export default function Feed() {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = usePosts();
  const navigate = useNavigate();
  
  const [showPauseReminder, setShowPauseReminder] = useState(false);
  const [pauseDismissed, setPauseDismissed] = useState(false);
  const { data: activeAds } = useActiveAds();
  const feedBgStyle = useCustomBackground('feed');
  const { feedStyle: feedCustomStyle } = useFeedCustomization();
  const { isMinor, isUnlocked, requestUnlock } = useParentalGate();
  const isMobile = useIsMobile();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useFeedScrollMemory('feed-main-scroll');
  const feedPerf = useFeedPerformance();
  const { isFlow } = useUXMode();

  // Deduplicate posts across pages to prevent React key warnings
  const posts = useMemo(() => {
    const all = data?.pages.flat() || [];
    const seen = new Set<string>();
    return all.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }, [data?.pages]);

  // Force virtualizer to remeasure when posts change (e.g. after delete)
  const postsKey = useMemo(() => posts.map(p => p.id).join(','), [posts]);

  // ── Virtualizer ──
  const virtualizer = useVirtualizer({
    count: posts.length,
    getScrollElement: () => document.documentElement,
    estimateSize: () => 480, // avg post height
    overscan: 5,
  });

  // Remeasure all items when posts array changes (delete, new page, etc.)
  useEffect(() => {
    if (postsKey) {
      virtualizer.measure();
    }
  }, [postsKey]);

  // Track feed load performance
  useEffect(() => {
    feedPerf.markFeedStart();
  }, []);

  useEffect(() => {
    if (!isLoading && posts.length > 0) {
      feedPerf.markFeedReady();
      feedPerf.trackPostsRendered(posts.length);
    }
  }, [isLoading, posts.length]);

  // Sample FPS every 2 minutes
  useEffect(() => {
    const iv = setInterval(() => feedPerf.measureFPS(), 120_000);
    const t = setTimeout(() => feedPerf.measureFPS(), 5000);
    return () => { clearInterval(iv); clearTimeout(t); };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      trackMinute();
      if (pauseDismissed) return;
      try {
        const wellbeingPrefs = JSON.parse(localStorage.getItem('wellbeing-prefs') || '{}');
        if (wellbeingPrefs.scrollPauseEnabled) {
          const sessionMin = getSessionMinutes();
          if (sessionMin >= (wellbeingPrefs.scrollPauseMinutes || 15)) {
            setShowPauseReminder(true);
          }
        }
        if (wellbeingPrefs.dailyLimitMinutes) {
          const todayMin = getTodayMinutes();
          if (todayMin >= wellbeingPrefs.dailyLimitMinutes && wellbeingPrefs.grayscaleAfterLimit) {
            document.documentElement.style.filter = 'grayscale(100%)';
          }
        }
      } catch {}
    }, 60000);
    return () => {
      clearInterval(interval);
      document.documentElement.style.filter = '';
    };
  }, [pauseDismissed]);

  // Infinite scroll: trigger fetch when last virtual items are near
  useEffect(() => {
    const items = virtualizer.getVirtualItems();
    const lastItem = items[items.length - 1];
    if (!lastItem) return;
    if (lastItem.index >= posts.length - 3 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [virtualizer.getVirtualItems(), hasNextPage, isFetchingNextPage, fetchNextPage, posts.length]);

  const renderInjection = useCallback((index: number) => {
    const type = INJECTION_MAP[index];
    
    if (!isMobile && activeAds?.length && index > 0 && index % 6 === 0) {
      const adIndex = Math.floor(index / 6) % activeAds.length;
      const ad = activeAds[adIndex];
      if (ad) {
        return <SponsoredPostCard ad={ad} />;
      }
    }
    
    if (!type) return null;

    return (
      <Suspense fallback={<div className="h-32 skeleton rounded-2xl" />}>
        {type === 'reels' && <FeedReelsSection />}
        {type === 'suggestions' && <FriendSuggestions />}
        {type === 'suggestions_city' && <FriendSuggestionsByCity />}
        {type === 'media' && <FeedMediaSection />}
        {type === 'marketplace' && <FeedMarketplaceSection />}
      </Suspense>
    );
  }, [isMobile, activeAds]);

  const dismissPause = () => {
    setShowPauseReminder(false);
    setPauseDismissed(true);
    sessionStorage.setItem('forsure-session-start', Date.now().toString());
  };

  const mergedFeedStyle = { ...feedBgStyle, ...feedCustomStyle };

  return (
    <AppLayout fullWidth>
      {feedBgStyle && (
        <div className="fixed inset-0 -z-10 opacity-30" style={feedBgStyle} />
      )}
      {feedCustomStyle.backgroundColor && (
        <div className="fixed inset-0 -z-10" style={{ backgroundColor: feedCustomStyle.backgroundColor }} />
      )}
      <div className="flex justify-center" style={{
        fontFamily: feedCustomStyle.fontFamily,
        color: feedCustomStyle.color,
      }}>
        <div className="w-full flex justify-center gap-6 xl:gap-10">
          <div className="flex-1 max-w-[680px] min-w-0">
            {/* Scroll pause reminder */}
            <AnimatePresence>
              {showPauseReminder && (
                <motion.div
                  initial={{ opacity: 0, y: -20, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -20, scale: 0.95 }}
                  className="px-4"
                >
                  <div className="relative p-5 rounded-2xl glass border border-primary/20 text-center space-y-3 overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5" />
                    <button onClick={dismissPause} className="absolute top-3 right-3 p-1.5 rounded-full hover:bg-secondary/50 z-10 transition-colors">
                      <X className="w-4 h-4 text-muted-foreground" />
                    </button>
                    <motion.div animate={{ y: [0, -5, 0] }} transition={{ repeat: Infinity, duration: 2 }}>
                      <Coffee className="w-9 h-9 text-primary mx-auto" />
                    </motion.div>
                    <p className="text-sm font-semibold relative z-10">Petite pause ? ☕</p>
                    <p className="text-xs text-muted-foreground relative z-10">
                      Vous scrollez depuis {getSessionMinutes()} minutes. Prenez un moment pour vous.
                    </p>
                    <div className="flex gap-2 justify-center pt-1 relative z-10">
                      <Button size="sm" variant="outline" className="text-xs rounded-xl" onClick={dismissPause}>
                        Continuer
                      </Button>
                      <Button size="sm" className="text-xs rounded-xl premium-button" onClick={() => navigate('/journal')}>
                        Écrire dans le journal
                      </Button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Flow mode: search + dashboard */}
            {isFlow && <FlowUniversalSearch />}
            {isFlow && <FlowDashboard />}

            {isMobile ? (
              <>
                <StoriesBar />
                <FeedZeusCard />
                <FeedLiveSection />
                <div className="px-3 pb-2"><CreatePost /></div>
              </>
            ) : (
              <>
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="px-4">
                  <StoriesBar />
                </motion.div>
                <FeedZeusCard />
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.05 }} className="px-4">
                  <FeedLiveSection />
                </motion.div>
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.1 }} className="px-4">
                  <CreatePost />
                </motion.div>
              </>
            )}

            {isLoading ? (
              <div className="space-y-3 px-4">
                {[1, 2, 3].map((i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: i * 0.1 }}
                    className="rounded-2xl overflow-hidden bg-card border border-border/30"
                  >
                    <div className="p-4 flex gap-3">
                      <div className="w-11 h-11 rounded-full skeleton" />
                      <div className="flex-1 space-y-2">
                        <div className="h-4 w-28 skeleton rounded-lg" />
                        <div className="h-3 w-16 skeleton rounded-lg" />
                      </div>
                    </div>
                    <div className="h-64 skeleton" />
                    <div className="p-4 flex gap-6">
                      <div className="h-5 w-14 skeleton rounded-lg" />
                      <div className="h-5 w-14 skeleton rounded-lg" />
                      <div className="h-5 w-14 skeleton rounded-lg" />
                    </div>
                  </motion.div>
                ))}
              </div>
            ) : posts.length === 0 ? (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="px-4"
              >
                <div className="premium-card p-10 text-center relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5" />
                  <Sparkles className="w-8 h-8 text-primary mx-auto mb-3 relative z-10" />
                  <p className="text-muted-foreground text-sm relative z-10">
                    Aucun post pour le moment.
                    <br />
                    <span className="text-primary font-medium">Soyez le premier à partager !</span>
                  </p>
                </div>
                <div className="mt-4 space-y-3">
                  <FeedLiveSection />
                  <Suspense fallback={null}>
                    <FeedReelsSection />
                    <FriendSuggestions />
                    <FeedMarketplaceSection />
                  </Suspense>
                </div>
              </motion.div>
            ) : (
              <>
                {/* Parental control banner */}
                {isMinor && !isUnlocked && (
                  <div className="px-4 mb-3">
                    <div className="flex items-center gap-3 p-3 rounded-xl bg-primary/5 border border-primary/20">
                      <Shield className="w-5 h-5 text-primary shrink-0" />
                      <div className="flex-1">
                        <p className="text-xs font-medium text-foreground">🛡️ Mode protégé actif</p>
                        <p className="text-[11px] text-muted-foreground">
                          Contenus filtrés • Messages d'inconnus bloqués • Profil privé
                        </p>
                      </div>
                      <Button size="sm" variant="outline" className="text-xs h-7 rounded-lg" onClick={() => requestUnlock()}>
                        <Lock className="w-3 h-3 mr-1" />
                        PIN
                      </Button>
                    </div>
                  </div>
                )}

                {/* Virtualized posts list */}
                <div
                  style={{
                    height: `${virtualizer.getTotalSize()}px`,
                    width: '100%',
                    position: 'relative',
                  }}
                >
                  {virtualizer.getVirtualItems().map((virtualRow) => {
                    const post = posts[virtualRow.index];
                    if (!post) return null;
                    return (
                      <div
                        key={post.id}
                        data-index={virtualRow.index}
                        ref={virtualizer.measureElement}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <div className="pb-2 sm:pb-4 sm:px-4">
                          <PostCard post={post} />
                          {renderInjection(virtualRow.index)}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {isFetchingNextPage && (
                  <div className="flex justify-center py-8">
                    <div className="w-10 h-10 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
                  </div>
                )}
              </>
            )}
          </div>
          <FeedRightSidebar />
        </div>
      </div>
    </AppLayout>
  );
}



