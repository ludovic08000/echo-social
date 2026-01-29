import { Link, useLocation } from 'react-router-dom';
import { Home, Search, Bell, User, Settings, PlusCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useUnreadCount } from '@/hooks/useNotifications';
import { cn } from '@/lib/utils';

const navItems = [
  { path: '/feed', icon: Home, label: 'Accueil' },
  { path: '/search', icon: Search, label: 'Rechercher' },
  { path: '/create', icon: PlusCircle, label: 'Créer' },
  { path: '/notifications', icon: Bell, label: 'Notifications' },
  { path: '/profile', icon: User, label: 'Profil' },
];

export function MobileNav() {
  const location = useLocation();
  const { user } = useAuth();
  const { data: unreadCount } = useUnreadCount();

  if (!user) return null;

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-card/95 backdrop-blur-lg border-t border-border/50 md:hidden safe-area-pb">
      <div className="flex items-center justify-around h-16">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path || 
            (item.path === '/profile' && location.pathname.startsWith('/profile'));
          const showBadge = item.path === '/notifications' && unreadCount && unreadCount > 0;
          
          return (
            <Link
              key={item.path}
              to={item.path === '/profile' ? `/profile/${user.id}` : item.path}
              className={cn(
                'flex flex-col items-center justify-center gap-1 px-3 py-2 rounded-xl transition-all duration-200',
                isActive 
                  ? 'text-primary' 
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <div className="relative">
                <item.icon className={cn('w-6 h-6', isActive && 'stroke-[2.5]')} />
                {showBadge && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </div>
              <span className="text-[10px] font-medium">{item.label}</span>
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
  const { data: unreadCount } = useUnreadCount();

  if (!user) return null;

  const sidebarItems = [
    { path: '/feed', icon: Home, label: 'Accueil' },
    { path: '/search', icon: Search, label: 'Rechercher' },
    { path: '/notifications', icon: Bell, label: 'Notifications' },
    { path: `/profile/${user.id}`, icon: User, label: 'Profil' },
    { path: '/settings', icon: Settings, label: 'Paramètres' },
  ];

  return (
    <aside className="hidden md:flex flex-col fixed left-0 top-0 bottom-0 w-64 bg-sidebar border-r border-sidebar-border p-4">
      <Link to="/feed" className="flex items-center gap-2 px-4 py-3 mb-6">
        <span className="text-2xl font-bold text-gradient">Pulse</span>
      </Link>

      <nav className="flex-1 space-y-1">
        {sidebarItems.map((item) => {
          const isActive = location.pathname === item.path ||
            (item.path.startsWith('/profile') && location.pathname.startsWith('/profile'));
          const showBadge = item.path === '/notifications' && unreadCount && unreadCount > 0;

          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                'pulse-nav-item',
                isActive && 'active'
              )}
            >
              <div className="relative">
                <item.icon className="w-5 h-5" />
                {showBadge && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">
                    {unreadCount > 9 ? '9+' : unreadCount}
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
        className="pulse-button-gradient flex items-center justify-center gap-2 w-full"
      >
        <PlusCircle className="w-5 h-5" />
        <span>Nouveau post</span>
      </Link>
    </aside>
  );
}
