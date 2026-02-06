import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { MobileNav } from './Navigation';
import { UserAvatar } from './UserAvatar';
import { useProfile } from '@/hooks/useProfile';
import { Settings } from 'lucide-react';

interface AppLayoutProps {
  children: ReactNode;
  requireAuth?: boolean;
}

function MobileHeader() {
  const { user } = useAuth();
  const { data: profile } = useProfile();

  if (!user) return null;

  return (
    <header className="sticky top-0 z-40 bg-card/95 backdrop-blur-lg border-b border-border/50 safe-area-pt">
      <div className="flex items-center justify-between h-14 px-4">
        <Link to="/feed" className="flex items-center gap-2">
          <span className="text-xl font-bold text-gradient">Pulse</span>
        </Link>
        
        <div className="flex items-center gap-3">
          <Link 
            to="/settings" 
            className="w-9 h-9 rounded-full bg-secondary/50 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          >
            <Settings className="w-5 h-5" />
          </Link>
          <Link to={`/profile/${user.id}`}>
            <UserAvatar src={profile?.avatar_url} alt={profile?.name} size="sm" />
          </Link>
        </div>
      </div>
    </header>
  );
}

export function AppLayout({ children, requireAuth = true }: AppLayoutProps) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-pulse-gradient animate-pulse-slow" />
          <span className="text-muted-foreground">Chargement...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <MobileHeader />
      <main className="pb-20">
        <div className="max-w-2xl mx-auto px-4 py-4">
          {children}
        </div>
      </main>
      <MobileNav />
    </div>
  );
}
