import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Home, Search, User, Settings, Plus, PlusCircle, MessageCircle, Users, FileText, Video, Radio, Bell, BookOpen, Trophy, Heart, Gamepad2, Tv, ShoppingBag, Brain, Compass, Sparkles, Megaphone, Bot, Shield } from 'lucide-react';
import BrandLogo from '@/components/BrandLogo';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { useUnreadCount } from '@/hooks/useNotifications';
import { useConversations } from '@/hooks/useMessages';
import { useFriendships } from '@/hooks/useFriendships';
import { useScrollHideNav } from '@/hooks/useScrollHideNav';
import { useChatWidget } from '@/components/ChatWidgetContext';

import { cn } from '@/lib/utils';

export function MobileNav() {
  const location = useLocation();
  const { user } = useAuth();
  const { t } = useTranslation();
  const { data: unreadCount } = useUnreadCount();
  const { data: conversations } = useConversations();
  const navHidden = useScrollHideNav();

  const unreadMessages = conversations?.reduce((sum, c) => sum + c.unread_count, 0) || 0;

  const { openChat } = useChatWidget();
  const [showMore, setShowMore] = React.useState(false);

  if (!user) return null;

  const active = (path: string) => {
    if (path === '/feed') return location.pathname === '/feed' || location.pathname === '/';
    if (path === '/groups') return location.pathname.startsWith('/group');
    if (path === '/lives') return location.pathname.startsWith('/live');
    return location.pathname === path;
  };

  const NavItem = ({ path, icon: Icon, label, badge }: { path: string; icon: any; label: string; badge?: number }) => (
    <Link to={path} className={cn(
      'flex flex-col items-center gap-[3px] pt-2 w-[52px] transition-all duration-300',
      active(path) ? 'text-primary' : 'text-muted-foreground'
    )}>
      <div className={cn(
        'relative p-1.5 rounded-2xl transition-all duration-300',
        active(path) && 'bg-primary/12 shadow-[0_0_12px_hsl(var(--primary)/0.15)]'
      )}>
        <Icon className={cn('w-[21px] h-[21px] transition-all', active(path) && 'stroke-[2.5]')} />
        {(badge ?? 0) > 0 && (
          <span className="absolute -top-0.5 -right-1 min-w-[15px] h-[15px] rounded-full bg-destructive text-destructive-foreground text-[8px] font-bold flex items-center justify-center px-[3px] shadow-[0_2px_6px_hsl(var(--destructive)/0.4)]">
            {(badge ?? 0) > 9 ? '9+' : badge}
          </span>
        )}
      </div>
      <span className={cn('text-[9px] leading-none tracking-wide', active(path) ? 'font-bold' : 'font-medium opacity-80')}>{label}</span>
    </Link>
  );


  return (
    <>
      {/* Menu étendu */}
      {showMore && (
        <div className="fixed inset-0 z-[60]" onClick={() => setShowMore(false)}>
          <div className="absolute inset-0 bg-background/60 backdrop-blur-sm" />
          <div className="absolute bottom-[68px] left-3 right-3 safe-area-pb z-[61] animate-slide-up">
            <div className="bg-card/95 backdrop-blur-2xl rounded-3xl border border-border/30 shadow-[var(--shadow-xl)] p-4">
              <div className="grid grid-cols-4 gap-3">
                {[
                  { path: '/groups', icon: Users, label: 'Groupes' },
                  { path: '/pages', icon: FileText, label: 'Pages' },
                  { path: '/marketplace', icon: ShoppingBag, label: 'Market' },
                  { path: '/ads', icon: Megaphone, label: 'Pub Ads' },
                  { path: '/friends', icon: Heart, label: 'Amis' },
                  { path: '/games', icon: Gamepad2, label: 'Jeux' },
                   { path: '/ai-agents', icon: Bot, label: 'Agents IA' },
                   { path: '/notifications', icon: Bell, label: 'Notifs', badge: unreadCount },
                   { path: '/settings', icon: Settings, label: 'Réglages' },
                 ].map((item) => (
                  <Link
                    key={item.path}
                    to={item.path}
                    onClick={() => setShowMore(false)}
                    className="flex flex-col items-center gap-1.5 py-3 rounded-2xl text-muted-foreground hover:text-primary hover:bg-primary/5 transition-all duration-200"
                  >
                    <div className="relative w-10 h-10 rounded-xl bg-secondary/80 flex items-center justify-center">
                      <item.icon className="w-5 h-5" />
                      {((item as any).badge ?? 0) > 0 && (
                        <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center px-1">
                          {(item as any).badge > 9 ? '9+' : (item as any).badge}
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] font-medium">{item.label}</span>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <nav className={cn(
        "fixed bottom-0 left-0 right-0 z-50 safe-area-pb transition-transform duration-300",
        "bg-card/95 border-t border-border/15",
        "md:bg-card/85 md:backdrop-blur-2xl",
        "shadow-[0_-4px_20px_hsl(var(--background)/0.5)]",
        navHidden && "translate-y-full"
      )}>
        <div className="flex items-end justify-evenly h-[60px] pb-1">
          <NavItem path="/feed" icon={Home} label="Accueil" />
          <NavItem path="/search" icon={Compass} label="Explorer" />

          {/* Bouton Créer — premium central */}
          <Link to="/create" className="flex flex-col items-center -mt-4 w-[56px]">
            <div className="relative">
              <div className="relative w-[46px] h-[46px] rounded-2xl bg-[image:var(--premium-gradient)] text-primary-foreground flex items-center justify-center shadow-[var(--shadow-gold)] active:scale-90 transition-all duration-200 border border-primary-foreground/10">
                <Plus className="w-6 h-6 stroke-[3]" />
              </div>
            </div>
          </Link>

          <NavItem path="/lives" icon={Radio} label="Live" />

          {/* Bouton Menu */}
          <button
            onClick={() => setShowMore(!showMore)}
            className={cn(
              'flex flex-col items-center gap-[3px] pt-2 w-[52px] transition-all duration-300',
              showMore ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            <div className={cn('relative p-1.5 rounded-2xl transition-all duration-300', showMore && 'bg-primary/12')}>
              <Sparkles className={cn('w-[21px] h-[21px]', showMore && 'stroke-[2.5]')} />
            </div>
            <span className={cn('text-[9px] leading-none tracking-wide', showMore ? 'font-bold' : 'font-medium opacity-80')}>Plus</span>
          </button>
        </div>
      </nav>
    </>
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

  const { openChat } = useChatWidget();

  const sidebarItems = [
    { path: '/feed', icon: Home, label: t('nav.home') },
    { path: '/search', icon: Search, label: t('nav.search') },
    { path: '/notifications', icon: Bell, label: t('nav.notifications'), badge: unreadCount },
    { path: '/messages', icon: MessageCircle, label: t('nav.messages'), badge: unreadMessages, isChat: true },
    { path: '/friends', icon: Users, label: t('nav.friends'), badge: friendRequests },
    { path: '/friend-match', icon: Heart, label: 'Matchmaking' },
    { path: '/challenges', icon: Trophy, label: 'Défis' },
    { path: '/games', icon: Gamepad2, label: 'Jeux' },
    { path: '/journal', icon: BookOpen, label: 'Journal' },
    { path: '/groups', icon: Users, label: t('nav.groups') },
    { path: '/pages', icon: FileText, label: t('nav.pages') },
    { path: '/channels', icon: Tv, label: 'Canaux TV' },
    { path: '/marketplace', icon: ShoppingBag, label: 'Marketplace' },
    { path: '/ai-engine', icon: Brain, label: 'Moteur IA' },
    { path: '/ai-agents', icon: Bot, label: 'Agents IA' },
    { path: '/admin', icon: Shield, label: 'Administration' },
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

          if ((item as any).isChat) {
            return (
              <button
                key={item.path}
                onClick={() => openChat()}
                className={cn('premium-nav-item w-full')}
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
              </button>
            );
          }
          
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
