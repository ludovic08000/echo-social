import { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ZeusCompanion } from './ZeusCompanion';
import { OnboardingBubbles } from './OnboardingBubbles';
import { useAuth } from '@/lib/auth';
import { MobileNav, DesktopSidebar } from './Navigation';
import { UserAvatar } from './UserAvatar';
import { useProfile } from '@/hooks/useProfile';
import { Bell, MessageCircle } from 'lucide-react';
import BrandLogo from '@/components/BrandLogo';
import { useUnreadCount } from '@/hooks/useNotifications';
import { useConversations } from '@/hooks/useMessages';
import { useScreenSize } from '@/hooks/useScreenSize';
import { useChatWidget } from '@/components/ChatWidgetContext';
import { useRealtimeNotifications } from '@/hooks/useRealtimeNotifications';
import { useIsMobile } from '@/hooks/use-mobile';
import { UXModeSwitchCompact } from '@/components/UXModeSwitch';
import { useUXMode } from '@/hooks/useUXMode';
import { FlowRadialMenu } from '@/components/flow/FlowRadialMenu';

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

  if (!user) return null;

  return (
    <header className="sticky top-0 z-40 bg-background/95 backdrop-blur-xl border-b border-border/10 safe-area-pt">
      <div className="flex items-center justify-between h-12 px-3">
         <Link to="/feed" className="flex items-center">
           <BrandLogo className="h-6 w-auto" />
         </Link>
        
        <div className="flex items-center gap-2">
          <UXModeSwitchCompact />
          <Link 
            to="/notifications" 
            className="relative w-8 h-8 rounded-xl bg-secondary/50 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors active:scale-95"
          >
            <Bell className="w-[18px] h-[18px]" strokeWidth={1.6} />
            {unreadCount && unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-[9px] h-[9px] rounded-full bg-destructive ring-[1.5px] ring-background" />
            )}
          </Link>
          <button 
            onClick={() => isMobile ? navigate('/messages') : openChat()}
            className="relative w-8 h-8 rounded-xl bg-secondary/50 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors active:scale-95"
          >
            <MessageCircle className="w-[18px] h-[18px]" strokeWidth={1.6} />
            {unreadMessages > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-[9px] h-[9px] rounded-full bg-destructive ring-[1.5px] ring-background" />
            )}
          </button>
          <Link
            to={`/profile/${user.id}`}
            className="w-8 h-8 rounded-xl overflow-hidden ring-1 ring-border/30 hover:ring-primary/40 transition-all active:scale-95"
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
      <MobileHeader />

      <main className="pb-16">
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
      <MobileNav />
    </div>
  );
}
