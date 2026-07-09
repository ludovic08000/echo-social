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

  // Guest mode: show simplified nav
  if (!user) {
    return (
      <nav className="fixed bottom-0 left-0 right-0 z-50 safe-area-pb bg-background/95 backdrop-blur-xl border-t border-border/10">
        <div className="flex items-stretch h-[50px]">
          <Link to="/feed" className={cn('flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 py-2', location.pathname === '/feed' ? 'text-primary' : 'text-muted-foreground')}>
            <Home className="w-5 h-5" strokeWidth={1.7} />
            <span className="text-[10px] font-medium">Explorer</span>
          </Link>
          <Link to="/search" className={cn('flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 py-2', location.pathname === '/search' ? 'text-primary' : 'text-muted-foreground')}>
            <Search className="w-5 h-5" strokeWidth={1.7} />
            <span className="text-[10px] font-medium">Chercher</span>
          </Link>
          <Link to="/videos" className={cn('flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 py-2', location.pathname === '/videos' ? 'text-primary' : 'text-muted-foreground')}>
            <Video className="w-5 h-5" strokeWidth={1.7} />
            <span className="text-[10px] font-medium">Vidéos</span>
          </Link>
          <Link to="/settings" className={cn('flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 py-2', location.pathname === '/settings' ? 'text-primary' : 'text-muted-foreground')}>
            <Settings className="w-5 h-5" strokeWidth={1.7} />
            <span className="text-[10px] font-medium">Réglages</span>
          </Link>
          <Link to="/signup" className="flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 py-2 text-primary">
            <User className="w-5 h-5" strokeWidth={1.7} />
            <span className="text-[10px] font-bold">S'inscrire</span>
          </Link>
        </div>
      </nav>
    );
  }

  const active = (path: string) => {
    if (path === '/feed') return location.pathname === '/feed' || location.pathname === '/';
    if (path === '/groups') return location.pathname.startsWith('/group');
    if (path === '/live') return location.pathname.startsWith('/live');
    return location.pathname === path;
  };

  const NavItem = ({ path, icon: Icon, label, badge }: { path: string; icon: any; label: string; badge?: number }) => (
    <Link to={path} className={cn(
      'flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 py-2 transition-all duration-200',
      active(path) ? 'text-primary' : 'text-muted-foreground'
    )}>
      <div className={cn(
        'relative p-1.5 rounded-xl transition-all duration-200',
        active(path) && 'bg-primary/10 shadow-[0_0_8px_hsl(var(--primary)/0.15)]'
      )}>
        <Icon
          className="w-5 h-5"
          strokeWidth={active(path) ? 2.4 : 1.7}
          fill={active(path) ? 'currentColor' : 'none'}
        />
        {(badge ?? 0) > 0 && (
          <span className="absolute -top-1 -right-1.5 min-w-[16px] h-4 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center px-1 shadow-sm">
            {(badge ?? 0) > 9 ? '9+' : badge}
          </span>
        )}
      </div>
      <span className={cn('text-[10px] leading-none tracking-tight', active(path) ? 'font-bold' : 'font-medium opacity-70')}>{label}</span>
    </Link>
  );


  return (
    <>
      {/* Menu étendu */}
      {showMore && (
        <div className="fixed inset-0 z-[60]" onClick={() => setShowMore(false)}>
          <div className="absolute inset-0 bg-background/60 backdrop-blur-sm" />
          <div className="absolute bottom-[70px] left-3 right-3 safe-area-pb z-[61] animate-slide-up">
            <div className="bg-card/95 rounded-3xl border border-border/20 shadow-[var(--shadow-xl)] p-5">
              <div className="grid grid-cols-4 gap-2">
                {[
                  { path: '/groups', icon: Users, label: 'Groupes' },
                  { path: '/pages', icon: FileText, label: 'Pages' },
                  { path: '/marketplace', icon: ShoppingBag, label: 'Market' },
                  { path: '/ads', icon: Megaphone, label: 'Pub Ads' },
                  { path: '/friends', icon: Heart, label: 'Amis' },
                   { path: '#zeus', icon: Bot, label: 'Zeus IA ⚡' },
                   { path: '/notifications', icon: Bell, label: 'Notifs', badge: unreadCount },
                   { path: '/settings', icon: Settings, label: 'Réglages' },
                 ].map((item) => (
                  item.path === '#zeus' ? (
                    <button
                      key="zeus"
                      onClick={() => { setShowMore(false); window.dispatchEvent(new Event('open-zeus')); }}
                      className="flex flex-col items-center gap-1.5 py-3 rounded-2xl text-primary hover:bg-primary/5 transition-all duration-200"
                    >
                      <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: 'var(--premium-gradient)' }}>
                        <item.icon className="w-5 h-5 text-primary-foreground" strokeWidth={1.7} />
                      </div>
                      <span className="text-[10px] font-bold">{item.label}</span>
                    </button>
                  ) : (
                  <Link
                    key={item.path}
                    to={item.path}
                    onClick={() => setShowMore(false)}
                    className="flex flex-col items-center gap-1.5 py-3 rounded-2xl text-muted-foreground hover:text-primary hover:bg-primary/5 transition-all duration-200"
                  >
                    <div className="relative w-11 h-11 rounded-xl bg-secondary/60 flex items-center justify-center">
                      <item.icon className="w-5 h-5" strokeWidth={1.7} />
                      {((item as any).badge ?? 0) > 0 && (
                        <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center px-1">
                          {(item as any).badge > 9 ? '9+' : (item as any).badge}
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] font-medium">{item.label}</span>
                  </Link>
                  )
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <nav className={cn(
        "fixed bottom-0 left-0 right-0 z-50 safe-area-pb transition-transform duration-300",
        "bg-background/95 backdrop-blur-xl border-t border-border/10",
        navHidden && "translate-y-full"
      )}>
        <div className="flex items-stretch h-[50px]">
          <NavItem path="/feed" icon={Home} label="Accueil" />
          <NavItem path="/friends" icon={Users} label="Amis" />

          {/* Bouton Créer — centré */}
          <Link to="/create" aria-label="Créer une publication" className="flex flex-col items-center justify-center flex-1 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-[image:var(--premium-gradient)] text-primary-foreground flex items-center justify-center shadow-[var(--shadow-gold)] active:scale-90 transition-transform duration-150">
              <Plus className="w-5 h-5 stroke-[2.5]" aria-hidden="true" />
            </div>
          </Link>

          <NavItem path="/live" icon={Radio} label="Live" />

          {/* Bouton Menu */}
          <button
            onClick={() => setShowMore(!showMore)}
            className={cn(
              'flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 py-2 transition-all duration-200',
              showMore ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            <div className={cn('relative p-1.5 rounded-xl transition-all duration-200', showMore && 'bg-primary/10')}>
              <Sparkles
                className="w-5 h-5"
                strokeWidth={showMore ? 2.4 : 1.7}
                fill={showMore ? 'currentColor' : 'none'}
              />
            </div>
            <span className={cn('text-[10px] leading-none tracking-tight', showMore ? 'font-bold' : 'font-medium opacity-70')}>Plus</span>
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

  const isActive = (path: string) => {
    if (path === '/feed') return location.pathname === '/feed' || location.pathname === '/';
    if (path.startsWith('/profile')) return location.pathname.startsWith('/profile');
    if (path === '/messages') return location.pathname.startsWith('/messages');
    return location.pathname === path;
  };

  const sidebarItems = [
    { path: '/feed', icon: Home, label: t('nav.home') },
    { path: '/search', icon: Search, label: t('nav.search') },
    { path: '/notifications', icon: Bell, label: t('nav.notifications'), badge: unreadCount },
    { path: '/messages', icon: MessageCircle, label: t('nav.messages'), badge: unreadMessages, isChat: true },
    { path: '/friends', icon: Users, label: t('nav.friends'), badge: friendRequests },
    { path: '/journal', icon: BookOpen, label: 'Journal' },
    { path: '/groups', icon: Users, label: t('nav.groups') },
    { path: '/pages', icon: FileText, label: t('nav.pages') },
    { path: '/channels', icon: Tv, label: 'Canaux TV' },
    { path: '/marketplace', icon: ShoppingBag, label: 'Marketplace' },
    { path: '/ai-engine', icon: Brain, label: 'Moteur IA' },
    { path: '#zeus', icon: Bot, label: 'Assistant IA', isZeus: true },
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
          const active = isActive(item.path);
          const showBadge = item.badge && item.badge > 0;

          if ((item as any).isChat) {
            return (
              <button
                key={item.path}
                onClick={() => openChat()}
                className={cn('premium-nav-item w-full')}
              >
                <div className="relative">
                  <item.icon className="w-5 h-5" strokeWidth={1.7} />
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

          if ((item as any).isZeus) {
            return (
              <button
                key="zeus-nav"
                onClick={() => window.dispatchEvent(new Event('open-zeus'))}
                className={cn('premium-nav-item w-full group')}
              >
                <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: 'var(--premium-gradient)' }}>
                  <item.icon className="w-3.5 h-3.5 text-primary-foreground" strokeWidth={1.7} />
                </div>
                <span className="font-semibold text-primary">{item.label} ⚡</span>
              </button>
            );
          }
          
          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                'premium-nav-item',
                active && 'active'
              )}
            >
              <div className="relative">
                <item.icon
                  className="w-5 h-5"
                  strokeWidth={active ? 2.4 : 1.7}
                  fill={active ? 'currentColor' : 'none'}
                />
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
        <PlusCircle className="w-5 h-5" strokeWidth={1.7} />
        <span>{t('nav.newPost')}</span>
      </Link>
    </aside>
  );
}
