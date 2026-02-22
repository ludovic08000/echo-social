import { Link, useLocation } from 'react-router-dom';
import { Home, Search, User, Settings, PlusCircle, MessageCircle, Users, FileText, Video, Radio, Bell, BookOpen, Trophy, Heart, Gamepad2, Tv, ShoppingBag } from 'lucide-react';
import BrandLogo from '@/components/BrandLogo';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { useUnreadCount } from '@/hooks/useNotifications';
import { useConversations } from '@/hooks/useMessages';
import { useFriendships } from '@/hooks/useFriendships';
import { useScrollHideNav } from '@/hooks/useScrollHideNav';
import { cn } from '@/lib/utils';

export function MobileNav() {
  const location = useLocation();
  const { user } = useAuth();
  const { t } = useTranslation();
  const { data: unreadCount } = useUnreadCount();
  const { data: conversations } = useConversations();
  const navHidden = useScrollHideNav();

  const unreadMessages = conversations?.reduce((sum, c) => sum + c.unread_count, 0) || 0;

  if (!user) return null;

  const navItems = [
    { path: '/feed', icon: Home, label: t('nav.home') },
    { path: '/videos', icon: Video, label: t('nav.videos') },
    { path: '/create', icon: PlusCircle, label: t('nav.create'), isCreate: true },
    { path: '/lives', icon: Radio, label: t('nav.lives') },
    { path: '/settings', icon: Settings, label: t('nav.more') },
  ];

  return (
    <nav className={cn(
      "fixed bottom-0 left-0 right-0 z-50 glass safe-area-pb transition-transform duration-300",
      navHidden && "translate-y-full"
    )}>
      <div className="flex items-center justify-around h-[60px] px-2">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path || 
            (item.path === '/profile' && location.pathname.startsWith('/profile')) ||
            (item.path === '/messages' && location.pathname.startsWith('/messages'));
          const showNotifBadge = item.path === '/notifications' && unreadCount && unreadCount > 0;
          const showMsgBadge = item.path === '/messages' && unreadMessages > 0;
          
          if (item.isCreate) {
            return (
              <Link
                key={item.path}
                to={item.path}
                className="flex flex-col items-center justify-center gap-0.5"
              >
                <div className="w-11 h-11 rounded-2xl bg-premium-gradient flex items-center justify-center shadow-premium-gold transition-transform duration-200 active:scale-95">
                  <PlusCircle className="w-5 h-5 text-primary-foreground" />
                </div>
              </Link>
            );
          }
          
          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                'flex flex-col items-center justify-center gap-0.5 px-3 py-1.5 rounded-2xl transition-all duration-200 min-w-[56px]',
                isActive 
                  ? 'text-primary' 
                  : 'text-muted-foreground active:text-foreground'
              )}
            >
              <div className="relative">
                <item.icon className={cn('w-6 h-6', isActive && 'stroke-[2.5]')} />
                {isActive && (
                  <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary" />
                )}
                {showNotifBadge && (
                  <span className="absolute -top-1 -right-1.5 w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
                {showMsgBadge && (
                  <span className="absolute -top-1 -right-1.5 w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center">
                    {unreadMessages > 9 ? '9+' : unreadMessages}
                  </span>
                )}
              </div>
              <span className={cn('text-[10px]', isActive ? 'font-semibold' : 'font-medium')}>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export function DesktopSidebar() {
  const location = useLocation();
  const { user } = useAuth();
  const { t } = useTranslation();
  const { data: unreadCount } = useUnreadCount();
  const { data: conversations } = useConversations();
  const { data: friendships } = useFriendships();

  const unreadMessages = conversations?.reduce((sum, c) => sum + c.unread_count, 0) || 0;
  const friendRequests = friendships?.requests.length || 0;

  if (!user) return null;

  const sidebarItems = [
    { path: '/feed', icon: Home, label: t('nav.home') },
    { path: '/videos', icon: Video, label: t('nav.videos') },
    { path: '/lives', icon: Radio, label: t('nav.lives') },
    { path: '/search', icon: Search, label: t('nav.search') },
    { path: '/notifications', icon: Bell, label: t('nav.notifications'), badge: unreadCount },
    { path: '/messages', icon: MessageCircle, label: t('nav.messages'), badge: unreadMessages },
    { path: '/friends', icon: Users, label: t('nav.friends'), badge: friendRequests },
    { path: '/friend-match', icon: Heart, label: 'Matchmaking' },
    { path: '/challenges', icon: Trophy, label: 'Défis' },
    { path: '/games', icon: Gamepad2, label: 'Jeux' },
    { path: '/journal', icon: BookOpen, label: 'Journal' },
    { path: '/groups', icon: Users, label: t('nav.groups') },
    { path: '/pages', icon: FileText, label: t('nav.pages') },
    { path: '/channels', icon: Tv, label: 'Canaux TV' },
    { path: '/marketplace', icon: ShoppingBag, label: 'Marketplace' },
    { path: `/profile/${user.id}`, icon: User, label: t('nav.profile') },
    { path: '/settings', icon: Settings, label: t('nav.settings') },
  ];

  return (
    <aside className="hidden md:flex flex-col fixed left-0 top-0 bottom-0 w-64 bg-sidebar border-r border-sidebar-border p-4">
      <Link to="/feed" className="flex items-center px-4 py-3 mb-6">
        <BrandLogo className="h-8 w-auto drop-shadow-[0_0_15px_hsl(220,70%,50%,0.3)]" />
      </Link>

      <nav className="flex-1 space-y-0.5">
        {sidebarItems.map((item) => {
          const isActive = location.pathname === item.path ||
            (item.path.startsWith('/profile') && location.pathname.startsWith('/profile')) ||
            (item.path === '/messages' && location.pathname.startsWith('/messages'));
          const showBadge = item.badge && item.badge > 0;

          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                'premium-nav-item',
                isActive && 'active'
              )}
            >
              <div className="relative">
                <item.icon className="w-5 h-5" />
                {showBadge && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">
                    {item.badge > 9 ? '9+' : item.badge}
                  </span>
                )}
              </div>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <Link
        to="/create"
        className="premium-button flex items-center justify-center gap-2 w-full"
      >
        <PlusCircle className="w-5 h-5" />
        <span>{t('nav.newPost')}</span>
      </Link>
    </aside>
  );
}
