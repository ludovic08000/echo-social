import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Home, Search, User, Settings, Plus,
  MessageCircle, Users, FileText, Video, Radio,
  Bell, BookOpen, Trophy, Heart, Gamepad2, Tv,
  ShoppingBag, Brain, Compass, Sparkles, Megaphone,
  Bot, Shield, Menu, MoreHorizontal, Grid3X3,
} from 'lucide-react';
import BrandLogo from '@/components/BrandLogo';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { useUnreadCount } from '@/hooks/useNotifications';
import { useConversations } from '@/hooks/useMessages';
import { useFriendships } from '@/hooks/useFriendships';
import { useScrollHideNav } from '@/hooks/useScrollHideNav';
import { useChatWidget } from '@/components/ChatWidgetContext';
import { cn } from '@/lib/utils';

/* ─────────────────────────────────────────────
   iOS-style filled icon helper
   Lucide icons don't have built-in fill variants,
   so we toggle fill + reduced stroke for active state
   ───────────────────────────────────────────── */

interface NavIconProps {
  icon: React.ElementType;
  active: boolean;
  size?: number;
}

function NavIcon({ icon: Icon, active, size = 24 }: NavIconProps) {
  return (
    <Icon
      className={cn(
        'transition-all duration-200',
        active ? 'text-primary' : 'text-muted-foreground'
      )}
      style={{ width: size, height: size }}
      strokeWidth={active ? 2.4 : 1.8}
      fill={active ? 'currentColor' : 'none'}
    />
  );
}

/* ─────────────────────────────────────────────
   Mobile Bottom Tab Bar — strict iOS HIG
   • 5 tabs max (Home, Friends, Create, Live, More)
   • 44pt minimum touch targets
   • Filled active icons, outline inactive
   • No text overflow, centered labels
   ───────────────────────────────────────────── */

export function MobileNav() {
  const location = useLocation();
  const { user } = useAuth();
  const { data: unreadCount } = useUnreadCount();
  const { data: conversations } = useConversations();
  const navHidden = useScrollHideNav();

  const unreadMessages = conversations?.reduce((sum, c) => sum + c.unread_count, 0) || 0;

  const { openChat } = useChatWidget();
  const [showMore, setShowMore] = React.useState(false);

  if (!user) return null;

  const isActive = (path: string) => {
    if (path === '/feed') return location.pathname === '/feed' || location.pathname === '/';
    if (path === '/live') return location.pathname.startsWith('/live');
    return location.pathname === path;
  };

  const TabItem = ({
    path, icon, label, badge, onClick,
  }: {
    path?: string; icon: React.ElementType; label: string; badge?: number; onClick?: () => void;
  }) => {
    const active = path ? isActive(path) : false;
    const content = (
      <>
        <div className="relative flex items-center justify-center w-7 h-7">
          <NavIcon icon={icon} active={active} size={22} />
          {(badge ?? 0) > 0 && (
            <span className="absolute -top-1 -right-1.5 min-w-[16px] h-4 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center px-1 ring-2 ring-background">
              {badge! > 9 ? '9+' : badge}
            </span>
          )}
        </div>
        <span className={cn(
          'text-[10px] leading-tight truncate max-w-full',
          active ? 'font-semibold text-primary' : 'font-normal text-muted-foreground'
        )}>
          {label}
        </span>
      </>
    );

    const classes = 'flex flex-col items-center justify-center gap-[2px] flex-1 min-w-0 min-h-[44px] select-none active:opacity-70 transition-opacity duration-100';

    if (onClick) {
      return <button className={classes} onClick={onClick}>{content}</button>;
    }
    return <Link to={path!} className={classes}>{content}</Link>;
  };

  return (
    <>
      {/* ── Expanded "More" grid ── */}
      {showMore && (
        <div className="fixed inset-0 z-[60]" onClick={() => setShowMore(false)}>
          <div className="absolute inset-0 bg-background/60 backdrop-blur-sm" />
          <div className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+56px)] left-3 right-3 z-[61] animate-slide-up">
            <div className="bg-card/95 rounded-2xl border border-border/15 shadow-premium-xl p-4">
              <div className="grid grid-cols-4 gap-3">
                {[
                  { path: '/friends', icon: Heart, label: 'Amis' },
                  { path: '/groups', icon: Users, label: 'Groupes' },
                  { path: '/pages', icon: FileText, label: 'Pages' },
                  { path: '/marketplace', icon: ShoppingBag, label: 'Market' },
                  { path: '/ads', icon: Megaphone, label: 'Pub Ads' },
                  { path: '/games', icon: Gamepad2, label: 'Jeux' },
                  { path: '#zeus', icon: Bot, label: 'Zeus IA' },
                  { path: '/notifications', icon: Bell, label: 'Notifs', badge: unreadCount },
                  { path: '/settings', icon: Settings, label: 'Réglages' },
                ].map((item) =>
                  item.path === '#zeus' ? (
                    <button
                      key="zeus"
                      onClick={(e) => { e.stopPropagation(); setShowMore(false); window.dispatchEvent(new Event('open-zeus')); }}
                      className="flex flex-col items-center gap-1.5 py-2.5 rounded-xl active:bg-primary/5 transition-colors min-h-[44px]"
                    >
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[image:var(--premium-gradient)]">
                        <item.icon className="w-5 h-5 text-primary-foreground" strokeWidth={1.8} />
                      </div>
                      <span className="text-[10px] font-semibold text-primary">Zeus IA</span>
                    </button>
                  ) : (
                    <Link
                      key={item.path}
                      to={item.path}
                      onClick={(e) => { e.stopPropagation(); setShowMore(false); }}
                      className="flex flex-col items-center gap-1.5 py-2.5 rounded-xl text-muted-foreground active:bg-accent/50 transition-colors min-h-[44px]"
                    >
                      <div className="relative w-10 h-10 rounded-xl bg-secondary/50 flex items-center justify-center">
                        <item.icon className="w-5 h-5" strokeWidth={1.8} />
                        {((item as any).badge ?? 0) > 0 && (
                          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center px-1">
                            {(item as any).badge > 9 ? '9+' : (item as any).badge}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] font-medium">{item.label}</span>
                    </Link>
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Tab Bar ── */}
      <nav className={cn(
        'fixed bottom-0 left-0 right-0 z-50 transition-transform duration-300',
        'bg-background/95 backdrop-blur-xl',
        'border-t border-border/10',
        navHidden && 'translate-y-full'
      )}
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className="flex items-stretch h-[52px] max-w-[600px] mx-auto">
          <TabItem path="/feed" icon={Home} label="Accueil" />
          <TabItem path="/messages" icon={MessageCircle} label="Messages" badge={unreadMessages} />

          {/* Create button — centered, elevated */}
          <Link to="/create" className="flex flex-col items-center justify-center flex-1 min-w-0 min-h-[44px]">
            <div className="w-10 h-10 rounded-[14px] bg-[image:var(--premium-gradient)] text-primary-foreground flex items-center justify-center shadow-premium-md active:scale-90 transition-transform duration-150">
              <Plus className="w-[22px] h-[22px]" strokeWidth={2.5} />
            </div>
          </Link>

          <TabItem path="/live" icon={Radio} label="Live" />
          <TabItem
            icon={Grid3X3}
            label="Plus"
            onClick={() => setShowMore(!showMore)}
          />
        </div>
      </nav>
    </>
  );
}

/* ─────────────────────────────────────────────
   Desktop Sidebar — kept but hidden; layout uses
   top header only (per project memory).
   This export is retained for backward compatibility.
   ───────────────────────────────────────────── */

export function DesktopSidebar() {
  return null;
}
