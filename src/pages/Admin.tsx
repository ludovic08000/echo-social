import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { toast } from '@/hooks/use-toast';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import {
  Shield, Users, Activity, LayoutDashboard, FileText, Flag, BarChart3, CreditCard, Lock, Settings,
  Brain, Zap, Archive, Gauge, Monitor, ScrollText, ShieldAlert, ChevronDown, Menu, X, KeyRound, Sparkles,
  MessageSquareWarning,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DashboardSection, UsersSection, PostsSection, ReportsSection,
  StatsSection, SubscriptionsSection, SecuritySection, SettingsSection,
  AISection, PlatformHealthDashboard, FeedIntelligenceSection, MonitoringSection,
  SecurityMonitoringSection, CryptoErrorsSection, MLFeedSection,
  CommentModerationAlertsSection,
} from '@/components/admin';
import { VerificationsSection } from '@/components/admin/VerificationsSection';
import { ArchivesSection } from '@/components/admin/ArchivesSection';
import { ZeusSection } from '@/components/admin/ZeusSection';
import { AuditLogsSection } from '@/components/admin/AuditLogsSection';
import { motion, AnimatePresence } from 'framer-motion';

const NAV_GROUPS = [
  {
    label: 'Général',
    items: [
      { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { key: 'health', label: 'Santé', icon: Activity },
      { key: 'stats', label: 'Statistiques', icon: BarChart3 },
      { key: 'monitoring', label: 'Monitoring', icon: Monitor },
    ],
  },
  {
    label: 'Gestion',
    items: [
      { key: 'users', label: 'Utilisateurs', icon: Users },
      { key: 'posts', label: 'Publications', icon: FileText },
      { key: 'reports', label: 'Signalements', icon: Flag },
      { key: 'comment_alerts', label: 'Alertes Zeus', icon: MessageSquareWarning },
      { key: 'verifications', label: 'Vérifications', icon: Shield },
      { key: 'archives', label: 'Archives', icon: Archive },
    ],
  },
  {
    label: 'Commerce',
    items: [
      { key: 'subscriptions', label: 'Commandes', icon: CreditCard },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { key: 'feed_intelligence', label: 'Feed IA', icon: Gauge },
      { key: 'ml_feed', label: 'ML Feed', icon: Sparkles },
      { key: 'ai', label: 'Moteur IA', icon: Brain },
      { key: 'zeus', label: 'Zeus', icon: Zap },
    ],
  },
  {
    label: 'Sécurité',
    items: [
      { key: 'security_ai', label: 'IA Sécurité', icon: ShieldAlert },
      { key: 'security', label: 'Anti-abus', icon: Lock },
      { key: 'crypto_errors', label: 'Erreurs E2EE', icon: KeyRound },
      { key: 'audit_logs', label: 'Audit', icon: ScrollText },
    ],
  },
  {
    label: 'Système',
    items: [
      { key: 'settings', label: 'Paramètres', icon: Settings },
    ],
  },
];

type AdminSection = 'dashboard' | 'health' | 'stats' | 'monitoring' | 'users' | 'posts' | 'reports' | 'verifications' | 'archives' | 'subscriptions' | 'feed_intelligence' | 'ml_feed' | 'ai' | 'zeus' | 'security_ai' | 'security' | 'crypto_errors' | 'audit_logs' | 'settings';

export default function Admin() {
  const [section, setSection] = useState<AdminSection>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const navigate = useNavigate();
  const { data: isAdmin, isLoading } = useIsAdmin();

  useEffect(() => {
    if (!isLoading && !isAdmin) {
      navigate('/feed');
      toast({ title: 'Accès refusé', description: "Vous n'avez pas les droits administrateur.", variant: 'destructive' });
    }
  }, [isAdmin, isLoading, navigate]);

  if (isLoading) {
    return (
      <AppLayout fullWidth>
        <div className="flex items-center justify-center h-[60vh]">
          <div className="flex flex-col items-center gap-3">
            <Shield className="w-8 h-8 text-primary animate-pulse" />
            <p className="text-sm text-muted-foreground">Vérification des droits…</p>
          </div>
        </div>
      </AppLayout>
    );
  }
  if (!isAdmin) return null;

  const toggleGroup = (label: string) => {
    setCollapsedGroups(prev => ({ ...prev, [label]: !prev[label] }));
  };

  const currentItem = NAV_GROUPS.flatMap(g => g.items).find(i => i.key === section) as { key: string; label: string; icon: any } | undefined;

  const renderSection = () => {
    switch (section) {
      case 'dashboard': return <DashboardSection />;
      case 'health': return <PlatformHealthDashboard />;
      case 'feed_intelligence': return <FeedIntelligenceSection />;
      case 'ml_feed': return <MLFeedSection />;
      case 'users': return <UsersSection />;
      case 'posts': return <PostsSection />;
      case 'reports': return <ReportsSection />;
      case 'verifications': return <VerificationsSection />;
      case 'archives': return <ArchivesSection />;
      case 'stats': return <StatsSection />;
      case 'subscriptions': return <SubscriptionsSection />;
      case 'ai': return <AISection />;
      case 'zeus': return <ZeusSection />;
      case 'audit_logs': return <AuditLogsSection />;
      case 'monitoring': return <MonitoringSection />;
      case 'security_ai': return <SecurityMonitoringSection />;
      case 'security': return <SecuritySection />;
      case 'crypto_errors': return <CryptoErrorsSection />;
      case 'settings': return <SettingsSection />;
    }
  };

  const NavContent = () => (
    <>
      {NAV_GROUPS.map(group => (
        <div key={group.label} className="mb-1">
          <button
            onClick={() => toggleGroup(group.label)}
            className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
          >
            <span>{group.label}</span>
            <ChevronDown className={cn('w-3 h-3 transition-transform', collapsedGroups[group.label] && '-rotate-90')} />
          </button>
          <AnimatePresence initial={false}>
            {!collapsedGroups[group.label] && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="overflow-hidden"
              >
                <div className="space-y-0.5 pb-2">
                  {group.items.map(item => {
                    const active = section === item.key;
                    return (
                      <button
                        key={item.key}
                        onClick={() => { setSection(item.key as AdminSection); setMobileMenuOpen(false); }}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-all',
                          active
                            ? 'bg-primary/15 text-primary font-medium ring-1 ring-primary/20 shadow-sm backdrop-blur-sm'
                            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                        )}
                      >
                        <item.icon className={cn('w-4 h-4 shrink-0', active && 'text-primary')} />
                        <span className="truncate">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ))}
    </>
  );

  return (
    <AppLayout fullWidth>
      <div className="flex min-h-[calc(100vh-4rem)] w-full">
        {/* Desktop Sidebar */}
        <aside className="w-60 shrink-0 border-r border-border/40 bg-card/30 backdrop-blur-xl hidden lg:flex flex-col sticky top-12 h-[calc(100vh-3rem)]">
          <div className="flex items-center gap-2.5 px-4 py-4 border-b border-border/30">
            <div className="w-9 h-9 rounded-2xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-md shadow-primary/20">
              <Shield className="w-4 h-4 text-primary-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-foreground truncate" style={{ fontFamily: 'Playfair Display, serif' }}>Console Admin</p>
              <p className="text-[10px] text-muted-foreground">ForSure</p>
            </div>
          </div>
          <ScrollArea className="flex-1 px-2 py-3">
            <NavContent />
          </ScrollArea>
        </aside>

        {/* Mobile Header */}
        <div className="lg:hidden fixed top-[3rem] left-0 right-0 z-30 bg-background/70 backdrop-blur-xl border-b border-border/40 px-4 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shrink-0">
              <Shield className="w-3.5 h-3.5 text-primary-foreground" />
            </div>
            <div className="flex items-center gap-1.5 min-w-0">
              {currentItem && <currentItem.icon className="w-4 h-4 text-primary shrink-0" />}
              <span className="text-sm font-semibold text-foreground truncate">{currentItem?.label}</span>
            </div>
          </div>
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0 rounded-full" onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </Button>
        </div>

        {/* Mobile Drawer */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <>
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="lg:hidden fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
                onClick={() => setMobileMenuOpen(false)}
              />
              <motion.div
                initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                className="lg:hidden fixed top-0 left-0 bottom-0 z-50 w-72 bg-card/95 backdrop-blur-2xl border-r border-border/40 shadow-2xl"
              >
                <div className="flex items-center gap-2.5 px-4 py-4 border-b border-border/30">
                  <div className="w-8 h-8 rounded-2xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center">
                    <Shield className="w-4 h-4 text-primary-foreground" />
                  </div>
                  <p className="text-sm font-bold text-foreground" style={{ fontFamily: 'Playfair Display, serif' }}>Administration</p>
                  <Button size="sm" variant="ghost" className="ml-auto h-8 w-8 p-0 rounded-full" onClick={() => setMobileMenuOpen(false)}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>
                <ScrollArea className="flex-1 px-2 py-3 h-[calc(100vh-4rem)]">
                  <NavContent />
                </ScrollArea>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        {/* Main */}
        <main className="flex-1 min-w-0 overflow-x-hidden">
          <div className="px-4 lg:px-8 py-6 lg:pt-6 pt-16 w-full max-w-none">
            {renderSection()}
          </div>
        </main>
      </div>
    </AppLayout>
  );
}
