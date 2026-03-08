import { Link } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { Heart, MessageCircle, Check, ShoppingBag } from 'lucide-react';
import { useNotifications, useMarkAsRead } from '@/hooks/useNotifications';
import { AppLayout } from '@/components/AppLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export default function Notifications() {
  const { data: notifications, isLoading } = useNotifications();
  const markAsRead = useMarkAsRead();

  const handleMarkAllRead = () => {
    markAsRead.mutate(undefined);
  };

  const unreadCount = notifications?.filter(n => !n.read_at).length || 0;

  return (
    <AppLayout>
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">Notifications</h1>
        {unreadCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleMarkAllRead}
            disabled={markAsRead.isPending}
          >
            <Check className="w-4 h-4 mr-2" />
            Tout marquer comme lu
          </Button>
        )}
      </header>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="pulse-card p-4 animate-pulse">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-3/4 bg-muted rounded" />
                  <div className="h-3 w-24 bg-muted rounded" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : notifications?.length === 0 ? (
        <div className="pulse-card p-8 text-center">
          <p className="text-muted-foreground">Aucune notification</p>
        </div>
      ) : (
        <div className="space-y-2">
          {notifications?.map((notification) => (
            <Link
              key={notification.id}
              to={notification.post_id ? `/post/${notification.post_id}` : '#'}
              onClick={() => {
                if (!notification.read_at) {
                  markAsRead.mutate(notification.id);
                }
              }}
            >
              <div
                className={cn(
                  'pulse-card p-4 flex items-center gap-3 transition-colors hover:bg-secondary/50',
                  !notification.read_at && 'bg-accent/50'
                )}
              >
                <div className="relative">
                  <UserAvatar
                    src={notification.actor.avatar_url}
                    alt={notification.actor.name}
                    size="md"
                  />
                  <div
                    className={cn(
                      'absolute -bottom-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center',
                      notification.type === 'like' ? 'bg-primary' :
                      notification.type === 'sale' ? 'bg-green-500' : 'bg-secondary'
                    )}
                  >
                    {notification.type === 'like' ? (
                      <Heart className="w-3 h-3 text-primary-foreground fill-current" />
                    ) : notification.type === 'sale' ? (
                      <ShoppingBag className="w-3 h-3 text-white" />
                    ) : (
                      <MessageCircle className="w-3 h-3 text-secondary-foreground" />
                    )}
                  </div>
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm">
                    <span className="font-medium">{notification.actor.name}</span>{' '}
                    {notification.type === 'like' ? 'a aimé votre post' :
                     notification.type === 'sale' ? 'a acheté un de vos produits 🎉' :
                     'a commenté votre post'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(notification.created_at), {
                      addSuffix: true,
                      locale: fr,
                    })}
                  </p>
                </div>

                {!notification.read_at && (
                  <div className="w-2 h-2 rounded-full bg-primary shrink-0" />
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </AppLayout>
  );
}
