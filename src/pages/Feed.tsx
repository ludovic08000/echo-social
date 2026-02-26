import { useEffect, useRef, useCallback } from 'react';
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
import { Loader2 } from 'lucide-react';

// Positions stratégiques d'injection de contenu entre les posts
// Optimisées pour maximiser l'engagement et le temps passé
const INJECTION_MAP: Record<number, 'suggestions' | 'reels' | 'live' | 'media' | 'marketplace'> = {
  1: 'live',          // Après 2 posts: FOMO avec les lives
  3: 'reels',         // Après 4 posts: contenu vidéo addictif
  5: 'suggestions',   // Après 6 posts: étendre le réseau
  8: 'media',         // Après 9 posts: galerie visuelle
  11: 'marketplace',  // Après 12 posts: shopping
  14: 'reels',        // Boucle: plus de reels
  18: 'live',         // Boucle: plus de lives
  22: 'suggestions',  // Boucle: plus de suggestions
};

export default function Feed() {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = usePosts();
  const navigate = useNavigate();
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const posts = data?.pages.flat() || [];

  // Auto-infinite scroll — pas de bouton, chargement automatique
  const handleObserver = useCallback((entries: IntersectionObserverEntry[]) => {
    const target = entries[0];
    if (target.isIntersecting && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  useEffect(() => {
    observerRef.current = new IntersectionObserver(handleObserver, {
      root: null,
      rootMargin: '400px', // Préchargement agressif — commence à charger 400px avant la fin
      threshold: 0,
    });

    if (loadMoreRef.current) {
      observerRef.current.observe(loadMoreRef.current);
    }

    return () => observerRef.current?.disconnect();
  }, [handleObserver]);

  // Re-observe when loadMoreRef changes
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

  return (
    <AppLayout fullWidth>
      <div className="flex justify-center">
        <div className="flex-1 max-w-[680px] min-w-0">
          <div className="space-y-2 py-2">
            {/* Stories — premier point d'engagement */}
            <div className="px-4">
              <StoriesBar />
            </div>

            {/* Create Post */}
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
                {/* Même sans posts, injecter du contenu pour retenir l'utilisateur */}
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

                {/* Auto-load trigger zone — invisible */}
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
