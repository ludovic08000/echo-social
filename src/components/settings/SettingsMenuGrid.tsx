import { User, Palette, Heart, Brain, Accessibility, Users, FileText, Shield, Bell, ChevronRight, LogOut, Gamepad2, Trophy, BookOpen, Search, MessageCircle, Tv, Baby, Smartphone } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { Link, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { useUnreadCount } from '@/hooks/useNotifications';
import { useConversations } from '@/hooks/useMessages';
import { useFriendships } from '@/hooks/useFriendships';

interface SettingsMenuGridProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
}

const iconColors: Record<string, string> = {
  profile: 'bg-primary/10 text-primary',
  appearance: 'bg-violet-500/10 text-violet-500',
  wellbeing: 'bg-rose-500/10 text-rose-500',
  content: 'bg-amber-500/10 text-amber-500',
  accessibility: 'bg-emerald-500/10 text-emerald-500',
  groups: 'bg-sky-500/10 text-sky-500',
  pages: 'bg-indigo-500/10 text-indigo-500',
  privacy: 'bg-teal-500/10 text-teal-500',
  notifications: 'bg-orange-500/10 text-orange-500',
  parental: 'bg-pink-500/10 text-pink-500',
  devices: 'bg-cyan-500/10 text-cyan-500',
};

const quickLinks = [
  { path: '/friends', icon: Users, label: 'Amis', color: 'bg-sky-500/10 text-sky-500' },
  { path: '/search', icon: Search, label: 'Rechercher', color: 'bg-violet-500/10 text-violet-500' },
  { path: '/messages', icon: MessageCircle, label: 'Messages', color: 'bg-primary/10 text-primary' },
  { path: '/journal', icon: BookOpen, label: 'Journal', color: 'bg-rose-500/10 text-rose-500' },
  { path: '/channels', icon: Tv, label: 'Canaux TV', color: 'bg-purple-500/10 text-purple-500' },
];

export function SettingsMenuGrid({ activeTab, onTabChange }: SettingsMenuGridProps) {
  const { t } = useTranslation();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { data: unreadCount } = useUnreadCount();
  const { data: conversations } = useConversations();
  const { data: friendships } = useFriendships();

  const unreadMessages = conversations?.reduce((sum, c) => sum + c.unread_count, 0) || 0;
  const friendRequests = friendships?.requests.length || 0;

  const getBadge = (path: string) => {
    if (path === '/messages' && unreadMessages > 0) return unreadMessages;
    if (path === '/friends' && friendRequests > 0) return friendRequests;
    return 0;
  };

  const handleSignOut = async () => {
    try {
      await signOut();
    } finally {
      // Hard reload to guarantee all in-memory state (E2EE keys, caches, guards) is wiped
      window.location.replace('/login');
    }
  };

  const allTabs = [
    { id: 'profile', label: t('settings.profile'), desc: t('settings.profileDesc'), icon: User, guestAllowed: false },
    { id: 'appearance', label: t('settings.appearance'), desc: t('settings.appearanceDesc'), icon: Palette, guestAllowed: true },
    { id: 'wellbeing', label: t('settings.wellbeing'), desc: t('settings.wellbeingDesc'), icon: Heart, guestAllowed: true },
    { id: 'content', label: t('settings.content'), desc: t('settings.contentDesc'), icon: Brain, guestAllowed: true },
    { id: 'accessibility', label: t('settings.accessibility'), desc: t('settings.accessibilityDesc'), icon: Accessibility, guestAllowed: true },
    { id: 'groups', label: t('settings.groups'), desc: t('settings.groupsDesc'), icon: Users, guestAllowed: false },
    { id: 'pages', label: t('settings.pages'), desc: t('settings.pagesDesc'), icon: FileText, guestAllowed: false },
    { id: 'privacy', label: t('settings.privacy'), desc: t('settings.privacyDesc'), icon: Shield, guestAllowed: false },
    { id: 'notifications', label: t('settings.notifications'), desc: t('settings.notificationsDesc'), icon: Bell, guestAllowed: false },
    { id: 'parental', label: 'Contrôle parental', desc: 'Code PIN et filtrage de contenu', icon: Baby, guestAllowed: true },
    { id: 'devices', label: 'Appareils connectés', desc: 'Gérer et révoquer vos appareils', icon: Smartphone, guestAllowed: false },
  ];

  const tabs = user ? allTabs : allTabs.filter(tab => tab.guestAllowed);

  return (
    <div className="grid grid-cols-1 gap-2 animate-fade-in">
      {/* Quick navigation links - mobile only, logged-in only */}
      {isMobile && user && (
        <div className="mb-4">
          <p className="px-1 mb-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Accès rapide
          </p>
          <div className="grid grid-cols-4 gap-2">
            {quickLinks.map((link) => {
              const badge = getBadge(link.path);
              return (
                <Link
                  key={link.path}
                  to={link.path}
                  className="flex flex-col items-center gap-1.5 p-3 rounded-2xl bg-card border border-border/40 hover:border-primary/20 hover:shadow-md active:scale-95 transition-all duration-200"
                >
                  <div className={cn('relative w-10 h-10 rounded-xl flex items-center justify-center', link.color)}>
                    <link.icon className="w-5 h-5" />
                    {badge > 0 && (
                      <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center">
                        {badge > 9 ? '9+' : badge}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] font-medium text-foreground truncate">{link.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Settings heading */}
      {isMobile && (
        <p className="px-1 mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Paramètres
        </p>
      )}

      {/* Guest banner */}
      {!user && (
        <Link
          to="/signup"
          className="flex items-center gap-3 p-4 rounded-2xl bg-primary/10 border border-primary/20 mb-2 hover:bg-primary/15 transition-colors"
        >
          <User className="w-5 h-5 text-primary" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-primary">Créer un compte</p>
            <p className="text-xs text-muted-foreground">Débloquez tous les paramètres</p>
          </div>
          <ChevronRight className="w-4 h-4 text-primary" />
        </Link>
      )}

      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={cn(
            'group flex items-center gap-3.5 w-full p-3.5 rounded-2xl text-left transition-all duration-200',
            'bg-card border border-border/40 hover:border-primary/20 hover:shadow-md',
            'active:scale-[0.98]',
            activeTab === tab.id && 'border-primary/30 bg-accent/50 shadow-md'
          )}
        >
          <div className={cn(
            'flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-200',
            iconColors[tab.id] || 'bg-primary/10 text-primary',
            activeTab === tab.id && 'scale-110'
          )}>
            <tab.icon className="w-5 h-5" />
          </div>

          <div className="flex-1 min-w-0">
            <p className={cn(
              'text-sm font-semibold truncate',
              activeTab === tab.id ? 'text-primary' : 'text-foreground'
            )}>
              {tab.label}
            </p>
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {tab.desc}
            </p>
          </div>

          <ChevronRight className={cn(
            'w-4 h-4 text-muted-foreground/50 transition-all duration-200 flex-shrink-0',
            'group-hover:text-primary group-hover:translate-x-0.5',
            activeTab === tab.id && 'text-primary'
          )} />
        </button>
      ))}

      {/* Sign out button - only for logged-in users */}
      {user && (
        <button
          onClick={handleSignOut}
          className="group flex items-center gap-3.5 w-full p-3.5 rounded-2xl text-left transition-all duration-200 bg-card border border-destructive/20 hover:border-destructive/40 hover:shadow-md active:scale-[0.98] mt-4"
        >
          <div className="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center bg-destructive/10 text-destructive">
            <LogOut className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-destructive">Se déconnecter</p>
            <p className="text-xs text-muted-foreground truncate mt-0.5">Quitter votre compte</p>
          </div>
          <ChevronRight className="w-4 h-4 text-destructive/50 group-hover:translate-x-0.5 transition-all duration-200 flex-shrink-0" />
        </button>
      )}
    </div>
  );
}
