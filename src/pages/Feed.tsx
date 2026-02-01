import { usePosts } from '@/hooks/usePosts';
import { AppLayout } from '@/components/AppLayout';
import { CreatePost } from '@/components/CreatePost';
import { PostCard } from '@/components/PostCard';
import { StoriesBar } from '@/components/StoriesBar';
import { Button } from '@/components/ui/button';
import { useNavigate, Link } from 'react-router-dom';
import { Plus, Search, MessageCircle, Menu } from 'lucide-react';
import { useNotifications } from '@/hooks/useNotifications';

export default function Feed() {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = usePosts();
  const navigate = useNavigate();
  const { data: notifications } = useNotifications();
  
  const unreadCount = notifications?.filter(n => !n.read_at).length || 0;

  const posts = data?.pages.flat() || [];

  return (
    <AppLayout>
      {/* Facebook-style Header */}
      <header className="flex items-center justify-between mb-4 sticky top-0 bg-background/95 backdrop-blur-lg z-20 py-3 -mx-4 px-4 border-b border-border md:hidden">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="h-9 w-9">
            <Menu className="w-5 h-5" />
          </Button>
          <h1 className="text-2xl font-bold text-primary">Pulse</h1>
        </div>
        
        <div className="flex items-center gap-1">
          <Link to="/create-post">
            <Button variant="ghost" size="icon" className="h-10 w-10 rounded-full bg-secondary">
              <Plus className="w-5 h-5" />
            </Button>
          </Link>
          <Link to="/search">
            <Button variant="ghost" size="icon" className="h-10 w-10 rounded-full bg-secondary">
              <Search className="w-5 h-5" />
            </Button>
          </Link>
          <Link to="/messages" className="relative">
            <Button variant="ghost" size="icon" className="h-10 w-10 rounded-full bg-secondary">
              <MessageCircle className="w-5 h-5" />
            </Button>
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 bg-destructive text-destructive-foreground text-xs rounded-full flex items-center justify-center font-medium">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </Link>
        </div>
      </header>

      <div className="space-y-3 -mx-4">
        {/* Stories Bar */}
        <div className="px-4">
          <StoriesBar />
        </div>

        {/* Create Post - Simplified */}
        <div className="px-4">
          <CreatePost />
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-card animate-pulse">
                <div className="p-4 flex gap-3">
                  <div className="w-10 h-10 rounded-full bg-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-32 bg-muted rounded" />
                    <div className="h-3 w-20 bg-muted rounded" />
                  </div>
                </div>
                <div className="h-80 bg-muted" />
                <div className="p-4 flex gap-4">
                  <div className="h-6 w-12 bg-muted rounded" />
                  <div className="h-6 w-12 bg-muted rounded" />
                  <div className="h-6 w-12 bg-muted rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : posts.length === 0 ? (
          <div className="px-4">
            <div className="pulse-card p-8 text-center">
              <p className="text-muted-foreground">
                Aucun post pour le moment.
                <br />
                Soyez le premier à partager quelque chose !
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {posts.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  onCommentClick={() => navigate(`/post/${post.id}`)}
                />
              ))}
            </div>

            {hasNextPage && (
              <div className="flex justify-center py-4 px-4">
                <Button
                  variant="ghost"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                  className="w-full"
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
