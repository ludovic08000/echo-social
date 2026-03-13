import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { useAuth } from '@/lib/auth';
import { toast } from '@/hooks/use-toast';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import {
  Shield, Users, Activity, LayoutDashboard, FileText, Flag, BarChart3, CreditCard, Lock, Settings,
  ChevronRight, Brain, Zap, Archive, Gauge, Monitor
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DashboardSection, UsersSection, PostsSection, ReportsSection,
  StatsSection, SubscriptionsSection, SecuritySection, SettingsSection,
  AISection, PlatformHealthDashboard, FeedIntelligenceSection,
} from '@/components/admin';
import { VerificationsSection } from '@/components/admin/VerificationsSection';
import { ArchivesSection } from '@/components/admin/ArchivesSection';
import { ZeusSection } from '@/components/admin/ZeusSection';

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'health', label: 'Santé Plateforme', icon: Activity },
  { key: 'feed_intelligence', label: 'Feed Intelligence', icon: Gauge },
  { key: 'users', label: 'Utilisateurs', icon: Users },
  { key: 'posts', label: 'Publications', icon: FileText },
  { key: 'reports', label: 'Signalements', icon: Flag },
  { key: 'verifications', label: 'Vérifications ID', icon: Shield },
  { key: 'archives', label: 'Archives Usurpation', icon: Archive },
  { key: 'stats', label: 'Statistiques', icon: BarChart3 },
  { key: 'subscriptions', label: 'Abonnements', icon: CreditCard },
  { key: 'ai', label: 'Intelligence Artificielle', icon: Brain },
  { key: 'zeus', label: '⚡ Console Zeus', icon: Zap },
  { key: 'security', label: 'Sécurité', icon: Lock },
  { key: 'settings', label: 'Paramètres', icon: Settings },
] as const;

type AdminSection = typeof NAV_ITEMS[number]['key'];

export default function Admin() {
  const [section, setSection] = useState<AdminSection>('dashboard');
  const navigate = useNavigate();
  const { data: isAdmin, isLoading } = useIsAdmin();

  useEffect(() => {
    if (!isLoading && !isAdmin) {
      navigate('/feed');
      toast({ title: 'Accès refusé', description: "Vous n'avez pas les droits administrateur.", variant: 'destructive' });
    }
  }, [isAdmin, isLoading, navigate]);

  if (isLoading) return <AppLayout><div className="flex items-center justify-center h-64 text-muted-foreground">Vérification des droits...</div></AppLayout>;
  if (!isAdmin) return null;

  const renderSection = () => {
    switch (section) {
      case 'dashboard': return <DashboardSection />;
      case 'health': return <PlatformHealthDashboard />;
      case 'feed_intelligence': return <FeedIntelligenceSection />;
      case 'users': return <UsersSection />;
      case 'posts': return <PostsSection />;
      case 'reports': return <ReportsSection />;
      case 'verifications': return <VerificationsSection />;
      case 'archives': return <ArchivesSection />;
      case 'stats': return <StatsSection />;
      case 'subscriptions': return <SubscriptionsSection />;
      case 'ai': return <AISection />;
      case 'zeus': return <ZeusSection />;
      case 'security': return <SecuritySection />;
      case 'settings': return <SettingsSection />;
    }
  };

  return (
    <AppLayout>
      <div className="flex min-h-[calc(100vh-4rem)]">
        <aside className="w-56 shrink-0 border-r border-border bg-card/50 p-3 hidden md:block">
          <div className="flex items-center gap-2 px-3 py-3 mb-2">
            <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center"><Shield className="w-4 h-4 text-primary" /></div>
            <span className="font-bold text-sm text-foreground">Admin</span>
          </div>
          <nav className="space-y-0.5">
            {NAV_ITEMS.map(item => (
              <button key={item.key} onClick={() => setSection(item.key)}
                className={cn('w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-all',
                  section === item.key ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground')}>
                <item.icon className="w-4 h-4" /><span>{item.label}</span>
                {section === item.key && <ChevronRight className="w-3 h-3 ml-auto" />}
              </button>
            ))}
          </nav>
        </aside>

        <div className="md:hidden w-full">
          <div className="overflow-x-auto border-b border-border px-2 py-2 flex gap-1 bg-card/50">
            {NAV_ITEMS.map(item => (
              <button key={item.key} onClick={() => setSection(item.key)}
                className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs whitespace-nowrap transition-all shrink-0',
                  section === item.key ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground')}>
                <item.icon className="w-3 h-3" />{item.label}
              </button>
            ))}
          </div>
          <div className="p-4">{renderSection()}</div>
        </div>

        <main className="flex-1 p-6 hidden md:block overflow-auto">{renderSection()}</main>
      </div>
    </AppLayout>
  );
}
