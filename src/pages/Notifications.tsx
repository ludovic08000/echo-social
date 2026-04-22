import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { Heart, MessageCircle, Check, ShoppingBag, UserPlus, UserCheck, Eye, SmilePlus, ShieldAlert } from 'lucide-react';
import { useNotifications, useMarkAsRead } from '@/hooks/useNotifications';
import { AppLayout } from '@/components/AppLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface GroupedNotification {
  key: string;
  type: string;
  post_id: string | null;
  actor_id: string;
  actors: { name: string; avatar_url: string | null }[];
  count: number;
  created_at: string;
  read_at: string | null;
  ids: string[];
}

function groupNotifications(notifications: any[]): GroupedNotification[] {
  const groups = new Map<string, GroupedNotification>();

  for (const n of notifications) {
    const shouldGroup = !['message', 'friend_request', 'friend_accepted', 'story_view', 'new_device'].includes(n.type);
    const key = shouldGroup ? `${n.type}-${n.post_id || 'no-post'}` : `${n.type}-${n.id}`;

    const existing = groups.get(key);
    if (existing && shouldGroup) {
      if (!existing.actors.some((a: any) => a.name === n.actor.name)) {
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
        actor_id: n.actor_id,
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

  const actionMap: Record<string, string> = {
    like: 'aimé votre publication',
    comment: 'commenté votre publication',
    sale: 'acheté un de vos produits 🎉',
    friend_request: 'vous a envoyé une demande d\'ami',
    friend_accepted: 'a accepté votre demande d\'ami',
    message: 'vous a envoyé un message',
    reaction: 'a réagi à votre publication',
    story_view: 'a vu votre story',
    new_device: 'Nouvel appareil connecté à votre compte — vérifiez immédiatement',
  };

  const action = actionMap[group.type] || 'a interagi avec vous';

  if (othersCount === 0) return action;
  if (othersCount === 1) return `et ${group.actors[1]?.name || '1 autre'} ont ${action}`;
  return `et ${othersCount} autres ont ${action}`;
}

function getNotificationLink(group: GroupedNotification): string {
  switch (group.type) {
    case 'message':
      return '/messages';
    case 'friend_request':
    case 'friend_accepted':
      return '/friends';
    case 'sale':
      return '/marketplace?sellerTab=orders';
    case 'story_view':
      return '/feed';
    case 'new_device':
      return '/settings?tab=devices';
    case 'like':
    case 'comment':
    case 'reaction':
      return group.post_id ? `/post/${group.post_id}#comments` : '/feed';
    default:
      return '/feed';
  }
}

function getNotificationIcon(type: string) {
  switch (type) {
    case 'like':
      return { icon: Heart, className: 'bg-primary', iconClass: 'text-primary-foreground fill-current' };
    case 'comment':
      return { icon: MessageCircle, className: 'bg-blue-500', iconClass: 'text-white' };
    case 'sale':
      return { icon: ShoppingBag, className: 'bg-green-500', iconClass: 'text-white' };
    case 'friend_request':
      return { icon: UserPlus, className: 'bg-amber-500', iconClass: 'text-white' };
    case 'friend_accepted':
      return { icon: UserCheck, className: 'bg-emerald-500', iconClass: 'text-white' };
    case 'message':
      return { icon: MessageCircle, className: 'bg-primary', iconClass: 'text-primary-foreground' };
    case 'reaction':
      return { icon: SmilePlus, className: 'bg-pink-500', iconClass: 'text-white' };
    case 'story_view':
      return { icon: Eye, className: 'bg-purple-500', iconClass: 'text-white' };
    case 'new_device':
      return { icon: ShieldAlert, className: 'bg-destructive', iconClass: 'text-destructive-foreground' };
    default:
      return { icon: MessageCircle, className: 'bg-secondary', iconClass: 'text-secondary-foreground' };
  }
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
          {grouped.map((group) => {
            const { icon: Icon, className: iconBg, iconClass } = getNotificationIcon(group.type);

            return (
              <Link
                key={group.key}
                to={getNotificationLink(group)}
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
                        iconBg
                      )}
                    >
                      <Icon className={cn('w-3 h-3', iconClass)} />
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
            );
          })}
        </div>
      )}
    </AppLayout>
  );
}
