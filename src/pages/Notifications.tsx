import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { Heart, MessageCircle, Check, ShoppingBag } from 'lucide-react';
import { useNotifications, useMarkAsRead } from '@/hooks/useNotifications';
import { AppLayout } from '@/components/AppLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface GroupedNotification {
  key: string;
  type: string;
  post_id: string | null;
  actors: { name: string; avatar_url: string | null }[];
  count: number;
  created_at: string;
  read_at: string | null;
  ids: string[];
}

function groupNotifications(notifications: any[]): GroupedNotification[] {
  const groups = new Map<string, GroupedNotification>();

  for (const n of notifications) {
    const key = `${n.type}-${n.post_id || 'no-post'}`;
    const existing = groups.get(key);
    if (existing) {
      if (!existing.actors.some(a => a.name === n.actor.name)) {
        existing.actors.push({ name: n.actor.name, avatar_url: n.actor.avatar_url });
      }
      existing.count++;
      existing.ids.push(n.id);
      if (!n.read_at) existing.read_at = null;
      if (new Date(n.created_at) > new Date(existing.created_at)) {
        existing.created_at = n.created_at;
      }
    } else {
      groups.set(key, {
        key,
        type: n.type,
        post_id: n.post_id,
        actors: [{ name: n.actor.name, avatar_url: n.actor.avatar_url }],
        count: 1,
        created_at: n.created_at,
        read_at: n.read_at,
        ids: [n.id],
      });
    }
  }

  return Array.from(groups.values()).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

function getNotificationText(group: GroupedNotification): string {
  const othersCount = group.count - 1;

  const action =
    group.type === 'like' ? 'aimé votre post' :
    group.type === 'sale' ? 'acheté un de vos produits 🎉' :
    'commenté votre post';

  if (othersCount === 0) return `a ${action}`;
  if (othersCount === 1) return `et ${group.actors[1]?.name || '1 autre'} ont ${action}`;
  return `et ${othersCount} autres ont ${action}`;
}

export default function Notifications() {
  const { data: notifications, isLoading } = useNotifications();
  const markAsRead = useMarkAsRead();

  const handleMarkAllRead = () => {
    markAsRead.mutate(undefined);
  };

  const unreadCount = notifications?.filter(n => !n.read_at).length || 0;

  const grouped = useMemo(
    () => groupNotifications(notifications || []),
    [notifications]
  );

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
      ) : grouped.length === 0 ? (
        <div className="pulse-card p-8 text-center">
          <p className="text-muted-foreground">Aucune notification</p>
        </div>
      ) : (
        <div className="space-y-2">
          {grouped.map((group) => (
            <Link
              key={group.key}
              to={group.type === 'sale' ? '/marketplace?sellerTab=orders' : group.post_id ? `/post/${group.post_id}#comments` : '#'}
              onClick={() => {
                if (!group.read_at) {
                  group.ids.forEach(id => markAsRead.mutate(id));
                }
              }}
            >
              <div
                className={cn(
                  'pulse-card p-4 flex items-center gap-3 transition-colors hover:bg-secondary/50',
                  !group.read_at && 'bg-accent/50'
                )}
              >
                <div className="relative">
                  <div className="flex -space-x-2">
                    {group.actors.slice(0, 3).map((actor, i) => (
                      <UserAvatar
                        key={i}
                        src={actor.avatar_url}
                        alt={actor.name}
                        size="md"
                        className={cn(i > 0 && 'ring-2 ring-background')}
                      />
                    ))}
                  </div>
                  <div
                    className={cn(
                      'absolute -bottom-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center',
                      group.type === 'like' ? 'bg-primary' :
                      group.type === 'sale' ? 'bg-green-500' : 'bg-secondary'
                    )}
                  >
                    {group.type === 'like' ? (
                      <Heart className="w-3 h-3 text-primary-foreground fill-current" />
                    ) : group.type === 'sale' ? (
                      <ShoppingBag className="w-3 h-3 text-white" />
                    ) : (
                      <MessageCircle className="w-3 h-3 text-secondary-foreground" />
                    )}
                  </div>
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm">
                    <span className="font-medium">{group.actors[0].name}</span>{' '}
                    {getNotificationText(group)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(group.created_at), {
                      addSuffix: true,
                      locale: fr,
                    })}
                  </p>
                </div>

                {!group.read_at && (
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