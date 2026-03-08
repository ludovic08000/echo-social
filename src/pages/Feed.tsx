import { useEffect, useRef, useCallback, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePosts } from '@/hooks/usePosts';
import { AppLayout } from '@/components/AppLayout';
import { CreatePost } from '@/components/CreatePost';
import { PostCard } from '@/components/PostCard';
import { StoriesBar } from '@/components/StoriesBar';
import { useNavigate } from 'react-router-dom';
import { FriendSuggestions } from '@/components/feed/FriendSuggestions';
import { FriendSuggestionsByCity } from '@/components/feed/FriendSuggestionsByCity';
import { FeedRightSidebar } from '@/components/feed/FeedRightSidebar';
import { FeedLiveSection } from '@/components/feed/FeedLiveSection';
import { FeedReelsSection } from '@/components/feed/FeedReelsSection';
import { FeedMarketplaceSection } from '@/components/feed/FeedMarketplaceSection';
import { FeedMediaSection } from '@/components/feed/FeedMediaSection';
import { SponsoredPostCard } from '@/components/feed/SponsoredPostCard';
import { Coffee, X, Sparkles } from 'lucide-react';
import { trackMinute, getTodayMinutes, getSessionMinutes } from '@/lib/feedAlgorithm';
import { Button } from '@/components/ui/button';
import { useActiveAds } from '@/hooks/useAdCampaigns';
import { useCustomBackground } from '@/hooks/useCustomBackground';

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

const postVariants = {
  hidden: { opacity: 0, y: 30, scale: 0.97 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      delay: Math.min(i * 0.06, 0.3),
      duration: 0.5,
      ease: [0.25, 0.46, 0.45, 0.94] as [number, number, number, number],
    },
  }),
};

export default function Feed() {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = usePosts();
  const navigate = useNavigate();
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const [showPauseReminder, setShowPauseReminder] = useState(false);
  const [pauseDismissed, setPauseDismissed] = useState(false);
  const { data: activeAds } = useActiveAds();
  const feedBgStyle = useCustomBackground('feed');

  const posts = data?.pages.flat() || [];

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

  const handleObserver = useCallback((entries: IntersectionObserverEntry[]) => {
    const target = entries[0];
    if (target.isIntersecting && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  useEffect(() => {
    observerRef.current = new IntersectionObserver(handleObserver, {
      root: null, rootMargin: '400px', threshold: 0,
    });
    if (loadMoreRef.current) observerRef.current.observe(loadMoreRef.current);
    return () => observerRef.current?.disconnect();
  }, [handleObserver]);

  useEffect(() => {
    if (loadMoreRef.current && observerRef.current) {
      observerRef.current.observe(loadMoreRef.current);
    }
  }, [posts.length]);

  const renderInjection = (index: number) => {
    const type = INJECTION_MAP[index];
    
    // Inject sponsored post every ~6 posts
    if (activeAds?.length && index > 0 && index % 6 === 0) {
      const adIndex = Math.floor(index / 6) % activeAds.length;
      const ad = activeAds[adIndex];
      if (ad) {
        return (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-50px' }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          >
            <SponsoredPostCard ad={ad} />
          </motion.div>
        );
      }
    }
    
    if (!type) return null;
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-50px' }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
      >
        {type === 'reels' && <FeedReelsSection />}
        {type === 'suggestions' && <FriendSuggestions />}
        {type === 'suggestions_city' && <FriendSuggestionsByCity />}
        {type === 'media' && <FeedMediaSection />}
        {type === 'marketplace' && <FeedMarketplaceSection />}
      </motion.div>
    );
  };

  const dismissPause = () => {
    setShowPauseReminder(false);
    setPauseDismissed(true);
    sessionStorage.setItem('forsure-session-start', Date.now().toString());
  };

  return (
    <AppLayout fullWidth>
      {feedBgStyle && (
        <div className="fixed inset-0 -z-10 opacity-30" style={feedBgStyle} />
      )}
      <div className="flex justify-center">
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

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="px-4"
            >
              <StoriesBar />
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.1 }}
              className="px-4"
            >
              <CreatePost />
            </motion.div>

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
                  <FeedReelsSection />
                  <FriendSuggestions />
                  <FeedMarketplaceSection />
                </div>
              </motion.div>
            ) : (
              <>
                <div className="space-y-3 px-4">
                  {posts.map((post, index) => (
                    <div key={post.id}>
                      <motion.div
                        custom={index}
                        variants={postVariants}
                        initial="hidden"
                        whileInView="visible"
                        viewport={{ once: true, margin: '-30px' }}
                      >
                        <PostCard
                          post={post}
                          onCommentClick={() => navigate(`/post/${post.id}`)}
                        />
                      </motion.div>
                      {renderInjection(index)}
                    </div>
                  ))}
                </div>

                <div ref={loadMoreRef} className="h-1" />
                
                <AnimatePresence>
                  {isFetchingNextPage && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="flex justify-center py-8"
                    >
                      <div className="relative">
                        <div className="w-10 h-10 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="w-4 h-4 rounded-full bg-primary/20 animate-pulse" />
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            )}
          </div>
          <FeedRightSidebar />
        </div>
      </div>
    </AppLayout>
  );
}
