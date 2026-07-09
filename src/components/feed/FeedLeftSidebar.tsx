import { Link, useLocation } from 'react-router-dom';
import { 
  Home, Users, Search, 
  Bell, MessageCircle, Settings,
  BookOpen,
  BarChart3, Bot, Megaphone, Store, Sparkles, Radio,
  FileText, UsersRound
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useProfile } from '@/hooks/useProfile';
import { UserAvatar } from '@/components/UserAvatar';
import { cn } from '@/lib/utils';
import { useUnreadCount } from '@/hooks/useNotifications';
import { useConversations } from '@/hooks/useMessages';
import { useFriendships } from '@/hooks/useFriendships';
import { useIsMobile } from '@/hooks/use-mobile';

const mainLinks = [
  { path: '/feed', icon: Home, label: 'Fil d\'actualité', bg: 'bg-blue-500', iconClass: 'text-white' },
  { path: '/friends', icon: Users, label: 'Amis', bg: 'bg-sky-500', iconClass: 'text-white' },
  { path: '/messages', icon: MessageCircle, label: 'Messenger', bg: 'bg-violet-500', iconClass: 'text-white' },
  { path: '/groups', icon: UsersRound, label: 'Groupes', bg: 'bg-cyan-500', iconClass: 'text-white' },
  { path: '/pages', icon: FileText, label: 'Pages', bg: 'bg-orange-500', iconClass: 'text-white' },
  { path: '/lives', icon: Radio, label: 'Lives', bg: 'bg-red-500', iconClass: 'text-white' },
  { path: '/marketplace', icon: Store, label: 'Marketplace', bg: 'bg-emerald-500', iconClass: 'text-white' },
  { path: '/journal', icon: BookOpen, label: 'Journal privé', bg: 'bg-teal-500', iconClass: 'text-white' },
  { path: '/dashboard', icon: BarChart3, label: 'Tableau de bord', bg: 'bg-indigo-500', iconClass: 'text-white' },
  { path: '/ai-agents', icon: Bot, label: 'Discuter avec des IA', bg: 'bg-fuchsia-500', iconClass: 'text-white' },
  { path: '/ads', icon: Megaphone, label: 'Espace Pubs', bg: 'bg-rose-500', iconClass: 'text-white' },
  { path: '/creator', icon: Sparkles, label: 'Créateur', bg: 'bg-yellow-500', iconClass: 'text-white' },
];

const shortcuts = [
  { path: '/notifications', icon: Bell, label: 'Notifications', bg: 'bg-red-500', iconClass: 'text-white' },
  { path: '/search', icon: Search, label: 'Rechercher', bg: 'bg-gray-500', iconClass: 'text-white' },
  { path: '/settings', icon: Settings, label: 'Paramètres', bg: 'bg-zinc-500', iconClass: 'text-white' },
];

export function FeedLeftSidebar() {
  const location = useLocation();
  const { user } = useAuth();
  const { data: profile } = useProfile();
  const { data: unreadCount } = useUnreadCount();
  const { data: conversations } = useConversations();
  const { data: friendships } = useFriendships();
  const isMobile = useIsMobile();

  const unreadMessages = conversations?.reduce((sum, c) => sum + c.unread_count, 0) || 0;
  const friendRequests = friendships?.requests.length || 0;

  if (!user || isMobile) return null;

  const getBadge = (path: string) => {
    if (path === '/notifications' && unreadCount && unreadCount > 0) return unreadCount;
    if (path === '/messages' && unreadMessages > 0) return unreadMessages;
    if (path === '/friends' && friendRequests > 0) return friendRequests;
    return 0;
  };

  return (
    <aside className="hidden lg:block w-[240px] xl:w-[280px] flex-shrink-0">
      <div className="sticky top-16 space-y-1 pr-2 max-h-[calc(100vh-80px)] overflow-y-auto scrollbar-thin">
        {/* Profile link */}
        <Link
          to={`/profile/${user.id}`}
          className={cn(
            'flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 group active:scale-95',
            location.pathname.startsWith('/profile')
              ? 'bg-accent text-foreground font-medium'
              : 'text-foreground hover:bg-secondary/60'
          )}
        >
          <UserAvatar src={profile?.avatar_url} alt={profile?.name} size="sm" />
          <span className="text-[15px] font-medium truncate">{profile?.name || 'Mon profil'}</span>
        </Link>

        {/* Main navigation */}
        <div className="space-y-0.5 pt-1">
          {mainLinks.map((item) => {
            const isActive = location.pathname === item.path;
            const badge = getBadge(item.path);

            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-xl transition-all duration-200 active:scale-95',
                  isActive
                    ? 'bg-accent text-foreground font-semibold'
                    : 'text-foreground hover:bg-secondary/60'
                )}
              >
                <div className={cn(
                  'relative w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 shadow-sm',
                  item.bg
                )}>
                  <item.icon className={cn('w-[17px] h-[17px]', item.iconClass)} strokeWidth={isActive ? 2.4 : 1.8} />
                  {badge > 0 && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center">
                      {badge > 9 ? '9+' : badge}
                    </span>
                  )}
                </div>
                <span className="text-[14px] truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>

        {/* Divider */}
        <div className="h-px bg-border/40 my-3 mx-3" />

        {/* Shortcuts */}
        <div className="space-y-0.5">
          <p className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Raccourcis
          </p>
          {shortcuts.map((item) => {
            const isActive = location.pathname === item.path;
            const badge = getBadge(item.path);

            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-xl transition-all duration-200 active:scale-95',
                  isActive
                    ? 'bg-accent text-foreground font-semibold'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                )}
              >
                <div className={cn(
                  'relative w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 shadow-sm',
                  item.bg
                )}>
                  <item.icon className={cn('w-4 h-4', item.iconClass)} strokeWidth={isActive ? 2.4 : 1.8} />
                  {badge > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center">
                      {badge > 9 ? '9+' : badge}
                    </span>
                  )}
                </div>
                <span className="text-sm truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>

        {/* Create post CTA */}
        <div className="pt-3 px-2">
          <Link
            to="/create"
            className="premium-button flex items-center justify-center gap-2 w-full text-sm py-2.5 active:scale-95"
          >
            <PlusCircle className="w-5 h-5" />
            <span>Créer un post</span>
          </Link>
        </div>

        {/* Footer */}
        <div className="pt-4 px-3">
          <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
            ForSure © 2025 · Confidentialité · Conditions
          </p>
        </div>
      </div>
    </aside>
  );
}
