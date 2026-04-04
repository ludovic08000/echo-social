import { Link, useLocation } from 'react-router-dom';
import { 
  Home, Users, FileText, Video, Radio, Search, 
  Bell, MessageCircle, Settings, ShoppingBag, Bookmark,
  User, PlusCircle, BookOpen, Trophy, Heart, Gamepad2,
  BarChart3, Bot, Megaphone, Store, Sparkles
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
  { path: '/feed', icon: Home, label: 'Fil d\'actualité' },
  { path: '/friends', icon: Users, label: 'Amis' },
  { path: '/friend-match', icon: Heart, label: 'Matchmaking' },
  { path: '/messages', icon: MessageCircle, label: 'Messenger' },
  { path: '/groups', icon: Users, label: 'Groupes' },
  { path: '/pages', icon: FileText, label: 'Pages' },
  { path: '/videos', icon: Video, label: 'Vidéos' },
  { path: '/lives', icon: Radio, label: 'Lives' },
  { path: '/marketplace', icon: Store, label: 'Marketplace' },
  { path: '/challenges', icon: Trophy, label: 'Défis' },
  { path: '/games', icon: Gamepad2, label: 'Jeux' },
  { path: '/journal', icon: BookOpen, label: 'Journal privé' },
  { path: '/dashboard', icon: BarChart3, label: 'Tableau de bord' },
  { path: '/ai-agents', icon: Bot, label: 'Discuter avec des IA' },
  { path: '/ads', icon: Megaphone, label: 'Espace Pubs' },
  { path: '/creator', icon: Sparkles, label: 'Créateur' },
];

const shortcuts = [
  { path: '/notifications', icon: Bell, label: 'Notifications' },
  { path: '/search', icon: Search, label: 'Rechercher' },
  { path: '/settings', icon: Settings, label: 'Paramètres' },
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
            'flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 group',
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
                  'flex items-center gap-3 px-3 py-2 rounded-xl transition-all duration-200',
                  isActive
                    ? 'bg-accent text-primary font-medium'
                    : 'text-foreground hover:bg-secondary/60'
                )}
              >
                <div className="relative w-8 h-8 rounded-lg bg-secondary/80 flex items-center justify-center flex-shrink-0">
                  <item.icon className={cn('w-[18px] h-[18px]', isActive ? 'text-primary' : 'text-foreground')} />
                  {badge > 0 && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center">
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
                  'flex items-center gap-3 px-3 py-2 rounded-xl transition-all duration-200',
                  isActive
                    ? 'bg-accent text-primary font-medium'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                )}
              >
                <div className="relative">
                  <item.icon className="w-5 h-5" />
                  {badge > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center">
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
            className="premium-button flex items-center justify-center gap-2 w-full text-sm py-2.5"
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
