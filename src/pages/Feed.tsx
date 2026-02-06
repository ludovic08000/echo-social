import { usePosts } from '@/hooks/usePosts';
import { AppLayout } from '@/components/AppLayout';
import { CreatePost } from '@/components/CreatePost';
import { PostCard } from '@/components/PostCard';
import { StoriesBar } from '@/components/StoriesBar';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { FriendSuggestions } from '@/components/feed/FriendSuggestions';
import { FeedLiveSection } from '@/components/feed/FeedLiveSection';
import { FeedReelsSection } from '@/components/feed/FeedReelsSection';
import { FeedMediaSection } from '@/components/feed/FeedMediaSection';
import { FeedLeftSidebar } from '@/components/feed/FeedLeftSidebar';
import { FeedRightSidebar } from '@/components/feed/FeedRightSidebar';

export default function Feed() {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = usePosts();
  const navigate = useNavigate();

  const posts = data?.pages.flat() || [];

  return (
    <AppLayout fullWidth>
      <div className="flex gap-6 justify-center">
        {/* Left Sidebar - Desktop only */}
        <FeedLeftSidebar />

        {/* Main Feed */}
        <div className="flex-1 max-w-[680px] min-w-0">
          <div className="space-y-2 py-2">
            {/* Stories Bar */}
            <div className="px-4 lg:px-0">
              <StoriesBar />
            </div>

            {/* Create Post */}
            <div className="px-4 lg:px-0">
              <CreatePost />
            </div>

            {/* Friend Suggestions */}
            <FriendSuggestions />

            {/* Live Streams */}
            <FeedLiveSection />

            {/* Reels */}
            <FeedReelsSection />

            {isLoading ? (
              <div className="space-y-2 px-4 lg:px-0">
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
              <div className="px-4 lg:px-0">
                <div className="premium-card p-10 text-center">
                  <p className="text-muted-foreground text-sm">
                    Aucun post pour le moment.
                    <br />
                    <span className="text-primary font-medium">Soyez le premier à partager !</span>
                  </p>
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
                      {index === 2 && <FeedMediaSection />}
                    </div>
                  ))}
                </div>

                {hasNextPage && (
                  <div className="flex justify-center py-4 px-4 lg:px-0">
                    <Button
                      variant="ghost"
                      onClick={() => fetchNextPage()}
                      disabled={isFetchingNextPage}
                      className="w-full h-11 rounded-2xl text-sm font-medium"
                    >
                      {isFetchingNextPage ? 'Chargement…' : 'Voir plus de posts'}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right Sidebar - Desktop only */}
        <FeedRightSidebar />
      </div>
    </AppLayout>
  );
}