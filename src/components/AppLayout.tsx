import { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ZeusCompanion } from './ZeusCompanion';
import { OnboardingBubbles } from './OnboardingBubbles';
import { useAuth } from '@/lib/auth';
import { MobileNav } from './Navigation';
import { UserAvatar } from './UserAvatar';
import { useProfile } from '@/hooks/useProfile';
import { Bell, MessageCircle, Search, Home, Users, Radio, ShoppingBag, Gamepad2, Settings } from 'lucide-react';
import BrandLogo from '@/components/BrandLogo';
import { useUnreadCount } from '@/hooks/useNotifications';
import { useConversations } from '@/hooks/useMessages';
import { useScreenSize } from '@/hooks/useScreenSize';
import { useChatWidget } from '@/components/ChatWidgetContext';
import { useRealtimeNotifications } from '@/hooks/useRealtimeNotifications';
import { UXModeSwitchCompact } from '@/components/UXModeSwitch';
import { useUXMode } from '@/hooks/useUXMode';
import { FlowRadialMenu } from '@/components/flow/FlowRadialMenu';
import { cn } from '@/lib/utils';
import { useLocation } from 'react-router-dom';

interface AppLayoutProps {
  children: ReactNode;
  requireAuth?: boolean;
  fullWidth?: boolean;
}

/* ─────────────────────────────────────────────
   Unified Top Header — all breakpoints
   Mobile: Logo + icons (bell, messages, avatar)
   Desktop: Logo + nav links + icons
   ───────────────────────────────────────────── */
function AppHeader() {
  const { user } = useAuth();
  const { data: profile } = useProfile();
  const { data: unreadCount } = useUnreadCount();
  const { data: conversations } = useConversations();
  const unreadMessages = conversations?.reduce((sum, c) => sum + c.unread_count, 0) || 0;
  const { openChat } = useChatWidget();
  const { isMobile } = useScreenSize();
  const navigate = useNavigate();
  const location = useLocation();

  if (!user) return null;

  const isActive = (path: string) => {
    if (path === '/feed') return location.pathname === '/feed' || location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  const desktopLinks = [
    { path: '/feed', icon: Home, label: 'Accueil' },
    { path: '/friends', icon: Users, label: 'Amis' },
    { path: '/live', icon: Radio, label: 'Live' },
    { path: '/marketplace', icon: ShoppingBag, label: 'Market' },
    { path: '/games', icon: Gamepad2, label: 'Jeux' },
  ];

  return (
    <header className="sticky top-0 z-40 bg-background/95 backdrop-blur-xl border-b border-border/10"
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
    >
      <div className="flex items-center justify-between h-12 px-3 md:px-6 max-w-[1280px] mx-auto">
        {/* Left — Logo */}
        <Link to="/feed" className="flex items-center shrink-0">
          <BrandLogo className="h-6 w-auto" />
        </Link>

        {/* Center — Desktop nav links */}
        <nav className="hidden md:flex items-center gap-1">
          {desktopLinks.map((item) => {
            const active = isActive(item.path);
            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-xl text-sm transition-all duration-200 min-h-[36px]',
                  active
                    ? 'text-primary font-semibold bg-primary/8'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                )}
              >
                <item.icon
                  className="w-[18px] h-[18px]"
                  strokeWidth={active ? 2.4 : 1.8}
                  fill={active ? 'currentColor' : 'none'}
                />
                <span className="hidden lg:inline">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Right — Action icons + Avatar */}
        <div className="flex items-center gap-0.5">
          <UXModeSwitchCompact />

          {/* Search — desktop only */}
          <Link
            to="/search"
            className="hidden md:flex w-9 h-9 rounded-full items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <Search className="w-[20px] h-[20px]" strokeWidth={1.8} />
          </Link>

          {/* Notifications */}
          <Link
            to="/notifications"
            className="relative w-9 h-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors active:scale-90"
          >
            <Bell className="w-[20px] h-[20px]" strokeWidth={1.8} />
            {unreadCount && unreadCount > 0 && (
              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-destructive ring-2 ring-background" />
            )}
          </Link>

          {/* Messages */}
          <button
            onClick={() => isMobile ? navigate('/messages') : openChat()}
            className="relative w-9 h-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors active:scale-90"
          >
            <MessageCircle className="w-[20px] h-[20px]" strokeWidth={1.8} />
            {unreadMessages > 0 && (
              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-destructive ring-2 ring-background" />
            )}
          </button>

          {/* Settings — desktop only */}
          <Link
            to="/settings"
            className="hidden md:flex w-9 h-9 rounded-full items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <Settings className="w-[18px] h-[18px]" strokeWidth={1.8} />
          </Link>

          {/* Profile Avatar */}
          <Link
            to={`/profile/${user.id}`}
            className="w-8 h-8 rounded-full overflow-hidden ring-2 ring-transparent hover:ring-primary/30 transition-all active:scale-90 ml-1"
          >
            <UserAvatar src={profile?.avatar_url} alt={profile?.name || ''} size="sm" />
          </Link>
        </div>
      </div>
    </header>
  );
}

export function AppLayout({ children, fullWidth = false }: AppLayoutProps) {
  const { user, loading } = useAuth();
  const { isFlow } = useUXMode();
  const { isDesktop } = useScreenSize();
  useRealtimeNotifications();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 rounded-2xl bg-premium-gradient animate-pulse-slow" />
          <span className="text-sm text-muted-foreground tracking-wide">Chargement…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />

      <main className={cn('pb-16 md:pb-4')}>
        {fullWidth ? (
          <div className="mx-auto max-w-[1280px]">
            {children}
          </div>
        ) : (
          <div className="mx-auto max-w-[680px] px-0 sm:px-2">
            {children}
          </div>
        )}
      </main>

      {user && <ZeusCompanion />}
      {user && <OnboardingBubbles />}
      {user && isFlow && <FlowRadialMenu />}
      {/* Bottom tab bar: mobile & tablet only */}
      {!isDesktop && <MobileNav />}
    </div>
  );
}
