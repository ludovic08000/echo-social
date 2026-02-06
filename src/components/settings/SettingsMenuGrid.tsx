import { User, Palette, Heart, Brain, Accessibility, Users, FileText, Shield, Bell, ChevronRight } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

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
};

export function SettingsMenuGrid({ activeTab, onTabChange }: SettingsMenuGridProps) {
  const { t } = useTranslation();

  const tabs = [
    { id: 'profile', label: t('settings.profile'), desc: t('settings.profileDesc'), icon: User },
    { id: 'appearance', label: t('settings.appearance'), desc: t('settings.appearanceDesc'), icon: Palette },
    { id: 'wellbeing', label: t('settings.wellbeing'), desc: t('settings.wellbeingDesc'), icon: Heart },
    { id: 'content', label: t('settings.content'), desc: t('settings.contentDesc'), icon: Brain },
    { id: 'accessibility', label: t('settings.accessibility'), desc: t('settings.accessibilityDesc'), icon: Accessibility },
    { id: 'groups', label: t('settings.groups'), desc: t('settings.groupsDesc'), icon: Users },
    { id: 'pages', label: t('settings.pages'), desc: t('settings.pagesDesc'), icon: FileText },
    { id: 'privacy', label: t('settings.privacy'), desc: t('settings.privacyDesc'), icon: Shield },
    { id: 'notifications', label: t('settings.notifications'), desc: t('settings.notificationsDesc'), icon: Bell },
  ];

  return (
    <div className="grid grid-cols-1 gap-2 animate-fade-in">
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
    </div>
  );
}
