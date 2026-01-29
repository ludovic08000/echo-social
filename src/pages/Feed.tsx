import { usePosts } from '@/hooks/usePosts';
import { AppLayout } from '@/components/AppLayout';
import { CreatePost } from '@/components/CreatePost';
import { PostCard } from '@/components/PostCard';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';

export default function Feed() {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = usePosts();
  const navigate = useNavigate();

  const posts = data?.pages.flat() || [];

  return (
    <AppLayout>
      <header className="flex items-center justify-between mb-6 sticky top-0 bg-background/95 backdrop-blur-lg z-10 py-3 -mx-4 px-4 border-b border-border/50 md:hidden">
        <h1 className="text-xl font-bold text-gradient">Pulse</h1>
      </header>

      <div className="space-y-4">
        <CreatePost />

        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="pulse-card p-5 animate-pulse">
                <div className="flex gap-3">
                  <div className="w-10 h-10 rounded-full bg-muted" />
                  <div className="flex-1 space-y-3">
                    <div className="h-4 w-32 bg-muted rounded" />
                    <div className="h-4 w-full bg-muted rounded" />
                    <div className="h-4 w-2/3 bg-muted rounded" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : posts.length === 0 ? (
          <div className="pulse-card p-8 text-center">
            <p className="text-muted-foreground">
              Aucun post pour le moment.
              <br />
              Soyez le premier à partager quelque chose !
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-4">
              {posts.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  onCommentClick={() => navigate(`/post/${post.id}`)}
                />
              ))}
            </div>

            {hasNextPage && (
              <div className="flex justify-center py-4">
                <Button
                  variant="ghost"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {isFetchingNextPage ? 'Chargement...' : 'Voir plus'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
}
