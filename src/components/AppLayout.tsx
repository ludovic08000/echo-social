import { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ZeusCompanion } from './ZeusCompanion';
import { OnboardingBubbles } from './OnboardingBubbles';
import { useAuth } from '@/lib/auth';
import { MobileNav, DesktopSidebar } from './Navigation';
import { UserAvatar } from './UserAvatar';
import { useProfile } from '@/hooks/useProfile';
import { Bell, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import BrandLogo from '@/components/BrandLogo';
import forsureWordmark from '@/assets/forsure-wordmark.png';
import { useUnreadCount } from '@/hooks/useNotifications';
import { useConversations } from '@/hooks/useMessages';
import { useScreenSize } from '@/hooks/useScreenSize';
import { useChatWidget } from '@/components/ChatWidgetContext';
import { useRealtimeNotifications } from '@/hooks/useRealtimeNotifications';
import { useIsMobile } from '@/hooks/use-mobile';
import { UXModeSwitchCompact } from '@/components/UXModeSwitch';
import { useUXMode } from '@/hooks/useUXMode';
import { FlowRadialMenu } from '@/components/flow/FlowRadialMenu';
import { GuestBanner } from '@/components/GuestBanner';

interface AppLayoutProps {
  children: ReactNode;
  requireAuth?: boolean;
  fullWidth?: boolean;
}

function MobileHeader() {
  const { user } = useAuth();
  const { data: profile } = useProfile();
  const { data: unreadCount } = useUnreadCount();
  const { data: conversations } = useConversations();
  const unreadMessages = conversations?.reduce((sum, c) => sum + c.unread_count, 0) || 0;
  const { openChat } = useChatWidget();
  const isMobile = useIsMobile();
  const navigate = useNavigate();

  if (!user) {
    return (
      <header className="sticky top-0 z-40 bg-background/95 backdrop-blur-xl border-b border-border/10 safe-area-pt">
        <div className="flex items-center justify-between h-12 px-3">
          <Link to="/feed" className="flex items-center">
            <BrandLogo className="h-6 w-auto" />
          </Link>
          <div />

        </div>
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-40 bg-background/95 backdrop-blur-xl border-b border-border/10 safe-area-pt">
      <div className="flex items-center justify-between h-14 px-3">
         <Link to="/feed" className="flex items-center">
           <img src={forsureWordmark} alt="Forsure" className="h-7 w-auto select-none" draggable={false} />
         </Link>
        
        <div className="flex items-center gap-2">
          <UXModeSwitchCompact />

          {/* Notification button — glassmorphism capsule */}
          <Link 
            to="/notifications" 
            className="relative group w-11 h-11 rounded-2xl bg-gradient-to-br from-accent/60 to-secondary/40 backdrop-blur-md border border-border/15 flex items-center justify-center text-muted-foreground hover:text-primary hover:border-primary/25 hover:shadow-[0_0_12px_hsl(var(--primary)/0.12)] transition-all duration-300 active:scale-90"
          >
            <Bell className="w-[22px] h-[22px] transition-transform duration-300 group-hover:scale-110" strokeWidth={1.8} />
            {unreadCount && unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center px-1 ring-2 ring-background shadow-sm animate-scale-in" />
            )}
          </Link>

          {/* Messages button — glassmorphism capsule */}
          <button 
            onClick={() => openChat()}
            className="relative group w-11 h-11 rounded-2xl bg-gradient-to-br from-accent/60 to-secondary/40 backdrop-blur-md border border-border/15 flex items-center justify-center text-muted-foreground hover:text-primary hover:border-primary/25 hover:shadow-[0_0_12px_hsl(var(--primary)/0.12)] transition-all duration-300 active:scale-90"
          >
            <MessageCircle className="w-[22px] h-[22px] transition-transform duration-300 group-hover:scale-110" strokeWidth={1.8} />
            {unreadMessages > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center px-1 ring-2 ring-background shadow-sm animate-scale-in">
                {unreadMessages > 9 ? '9+' : unreadMessages}
              </span>
            )}
          </button>

          {/* Avatar — premium ring */}
          <Link
            to={`/profile/${user.id}`}
            className="w-11 h-11 rounded-2xl overflow-hidden border-2 border-transparent bg-gradient-to-br from-primary/20 to-accent/30 p-[2px] hover:from-primary/40 hover:to-primary/20 transition-all duration-300 active:scale-90"
          >
            <div className="w-full h-full rounded-[calc(1rem-2px)] overflow-hidden">
              <UserAvatar src={profile?.avatar_url} alt={profile?.name || ''} size="sm" />
            </div>
          </Link>
        </div>
      </div>
    </header>
  );
}

export function AppLayout({ children, fullWidth = false }: AppLayoutProps) {
  const { user, loading } = useAuth();
  const { isFlow } = useUXMode();
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
      {!user && <GuestBanner />}
      <MobileHeader />

      <main className="pb-16">
        {fullWidth ? (
          <div className="w-full">
            {children}
          </div>
        ) : (
          <div className="mx-auto max-w-[680px] px-0 sm:px-2">
            {children}
          </div>
        )}
      </main>
      
      <ZeusCompanion />
      {user && <OnboardingBubbles />}
      {user && isFlow && <FlowRadialMenu />}
      <MobileNav />
    </div>
  );
}
