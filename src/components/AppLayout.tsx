import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ZeusCompanion } from './ZeusCompanion';
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

  if (!user) return null;

  return (
    <header className="sticky top-0 z-40 glass safe-area-pt">
      <div className="flex items-center justify-between h-14 px-4">
         <Link to="/feed" className="flex items-center">
           <BrandLogo className="h-7 w-auto drop-shadow-[0_0_12px_hsl(220,70%,50%,0.3)]" />
         </Link>
        
        <div className="flex items-center gap-2">
          <Link 
            to="/notifications" 
            className="relative w-10 h-10 rounded-full bg-secondary/60 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-all duration-200"
          >
            <Bell className="w-5 h-5" />
            {unreadCount && unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-[18px] h-[18px] rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center ring-2 ring-background">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </Link>
          <button 
            onClick={() => openChat()}
            className="relative w-10 h-10 rounded-full bg-secondary/60 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-all duration-200"
          >
            <MessageCircle className="w-5 h-5" />
            {unreadMessages > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-[18px] h-[18px] rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center ring-2 ring-background">
                {unreadMessages > 9 ? '9+' : unreadMessages}
              </span>
            )}
          </button>
          <Link to={`/profile/${user.id}`} className="flex-shrink-0">
            <UserAvatar src={profile?.avatar_url} alt={profile?.name} size="md" />
          </Link>
        </div>
      </div>
    </header>
  );
}

export function AppLayout({ children, fullWidth = false }: AppLayoutProps) {
  const { user, loading } = useAuth();

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

      <main className="pb-20">
        {fullWidth ? (
          <div className="mx-auto px-4 max-w-[1280px]">
            {children}
          </div>
        ) : (
          <div className="mx-auto max-w-[680px]">
            {children}
          </div>
        )}
      </main>
      
      {user && <ZeusCompanion />}
      <MobileNav />
    </div>
  );
}
