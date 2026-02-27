import { useEffect, useRef, useCallback, useState } from 'react';
import { usePosts } from '@/hooks/usePosts';
import { AppLayout } from '@/components/AppLayout';
import { CreatePost } from '@/components/CreatePost';
import { PostCard } from '@/components/PostCard';
import { StoriesBar } from '@/components/StoriesBar';
import { useNavigate } from 'react-router-dom';
import { FriendSuggestions } from '@/components/feed/FriendSuggestions';
import { FeedLiveSection } from '@/components/feed/FeedLiveSection';
import { FeedReelsSection } from '@/components/feed/FeedReelsSection';
import { FeedMarketplaceSection } from '@/components/feed/FeedMarketplaceSection';
import { FeedMediaSection } from '@/components/feed/FeedMediaSection';
import { Loader2, Coffee, X } from 'lucide-react';
import { trackMinute, getTodayMinutes, getSessionMinutes } from '@/lib/feedAlgorithm';
import { Button } from '@/components/ui/button';

// Injection positions for content between posts
const INJECTION_MAP: Record<number, 'suggestions' | 'reels' | 'live' | 'media' | 'marketplace'> = {
  1: 'live',
  3: 'reels',
  5: 'suggestions',
  8: 'media',
  11: 'marketplace',
  14: 'reels',
  18: 'live',
  22: 'suggestions',
};

export default function Feed() {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = usePosts();
  const navigate = useNavigate();
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const [showPauseReminder, setShowPauseReminder] = useState(false);
  const [pauseDismissed, setPauseDismissed] = useState(false);

  const posts = data?.pages.flat() || [];

  // ── Wellbeing: track usage & scroll pause ──
  useEffect(() => {
    const interval = setInterval(() => {
      trackMinute();
      
      // Check scroll pause setting
      if (pauseDismissed) return;
      try {
        const wellbeingPrefs = JSON.parse(localStorage.getItem('wellbeing-prefs') || '{}');
        if (wellbeingPrefs.scrollPauseEnabled) {
          const sessionMin = getSessionMinutes();
          if (sessionMin >= (wellbeingPrefs.scrollPauseMinutes || 15)) {
            setShowPauseReminder(true);
          }
        }
        // Check daily limit
        if (wellbeingPrefs.dailyLimitMinutes) {
          const todayMin = getTodayMinutes();
          if (todayMin >= wellbeingPrefs.dailyLimitMinutes && wellbeingPrefs.grayscaleAfterLimit) {
            document.documentElement.style.filter = 'grayscale(100%)';
          }
        }
      } catch {}
    }, 60000); // Every minute

    return () => {
      clearInterval(interval);
      document.documentElement.style.filter = '';
    };
  }, [pauseDismissed]);

  // Auto-infinite scroll
  const handleObserver = useCallback((entries: IntersectionObserverEntry[]) => {
    const target = entries[0];
    if (target.isIntersecting && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  useEffect(() => {
    observerRef.current = new IntersectionObserver(handleObserver, {
      root: null,
      rootMargin: '400px',
      threshold: 0,
    });
    if (loadMoreRef.current) {
      observerRef.current.observe(loadMoreRef.current);
    }
    return () => observerRef.current?.disconnect();
  }, [handleObserver]);

  useEffect(() => {
    if (loadMoreRef.current && observerRef.current) {
      observerRef.current.observe(loadMoreRef.current);
    }
  }, [posts.length]);

  const renderInjection = (index: number) => {
    const type = INJECTION_MAP[index];
    if (!type) return null;
    switch (type) {
      case 'live': return <FeedLiveSection key={`inject-live-${index}`} />;
      case 'reels': return <FeedReelsSection key={`inject-reels-${index}`} />;
      case 'suggestions': return <FriendSuggestions key={`inject-sug-${index}`} />;
      case 'media': return <FeedMediaSection key={`inject-media-${index}`} />;
      case 'marketplace': return <FeedMarketplaceSection key={`inject-mp-${index}`} />;
      default: return null;
    }
  };

  const dismissPause = () => {
    setShowPauseReminder(false);
    setPauseDismissed(true);
    // Reset session timer
    sessionStorage.setItem('forsure-session-start', Date.now().toString());
  };

  return (
    <AppLayout fullWidth>
      <div className="flex justify-center">
        <div className="flex-1 max-w-[680px] min-w-0">
          <div className="space-y-2 py-2">
            {/* Scroll pause reminder */}
            {showPauseReminder && (
              <div className="px-4">
                <div className="relative p-4 rounded-2xl bg-gradient-to-br from-primary/10 to-accent/10 border border-primary/20 text-center space-y-2">
                  <button onClick={dismissPause} className="absolute top-2 right-2 p-1 rounded-full hover:bg-secondary/50">
                    <X className="w-4 h-4 text-muted-foreground" />
                  </button>
                  <Coffee className="w-8 h-8 text-primary mx-auto" />
                  <p className="text-sm font-semibold">Petite pause ? ☕</p>
                  <p className="text-xs text-muted-foreground">
                    Vous scrollez depuis {getSessionMinutes()} minutes. Prenez un moment pour vous.
                  </p>
                  <div className="flex gap-2 justify-center pt-1">
                    <Button size="sm" variant="outline" className="text-xs rounded-xl" onClick={dismissPause}>
                      Continuer
                    </Button>
                    <Button size="sm" className="text-xs rounded-xl" onClick={() => navigate('/journal')}>
                      Écrire dans le journal
                    </Button>
                  </div>
                </div>
              </div>
            )}

            <div className="px-4">
              <StoriesBar />
            </div>

            <div className="px-4">
              <CreatePost />
            </div>

            {isLoading ? (
              <div className="space-y-2 px-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="rounded-2xl overflow-hidden bg-card border border-border/30">
                    <div className="p-4 flex gap-3">
                      <div className="w-10 h-10 rounded-full bg-muted animate-pulse" />
                      <div className="flex-1 space-y-2">
                        <div className="h-4 w-28 bg-muted rounded-lg animate-pulse" />
                        <div className="h-3 w-16 bg-muted rounded-lg animate-pulse" />
                      </div>
                    </div>
                    <div className="h-64 bg-muted animate-pulse" />
                    <div className="p-4 flex gap-6">
                      <div className="h-5 w-14 bg-muted rounded-lg animate-pulse" />
                      <div className="h-5 w-14 bg-muted rounded-lg animate-pulse" />
                      <div className="h-5 w-14 bg-muted rounded-lg animate-pulse" />
                    </div>
                  </div>
                ))}
              </div>
            ) : posts.length === 0 ? (
              <div className="px-4">
                <div className="premium-card p-10 text-center">
                  <p className="text-muted-foreground text-sm">
                    Aucun post pour le moment.
                    <br />
                    <span className="text-primary font-medium">Soyez le premier à partager !</span>
                  </p>
                </div>
                <div className="mt-4 space-y-2">
                  <FeedLiveSection />
                  <FeedReelsSection />
                  <FriendSuggestions />
                  <FeedMarketplaceSection />
                </div>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  {posts.map((post, index) => (
                    <div key={post.id}>
                      <PostCard
                        post={post}
                        onCommentClick={() => navigate(`/post/${post.id}`)}
                      />
                      {renderInjection(index)}
                    </div>
                  ))}
                </div>

                <div ref={loadMoreRef} className="h-1" />
                
                {isFetchingNextPage && (
                  <div className="flex justify-center py-6">
                    <Loader2 className="w-6 h-6 text-primary animate-spin" />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
