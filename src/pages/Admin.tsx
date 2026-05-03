import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { useAuth } from '@/lib/auth';
import { toast } from '@/hooks/use-toast';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import {
  Shield, Users, LayoutDashboard, FileText, Flag, BarChart3, CreditCard, Settings,
  Brain, Archive, ScrollText, ShieldAlert, ChevronDown, Menu, X, Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  PostsSection, ReportsSection, StatsSection, SubscriptionsSection, SettingsSection,
} from '@/components/admin';
import { UsersSection } from '@/components/admin/UsersSection';
import { VerificationsSection } from '@/components/admin/VerificationsSection';
import { ArchivesSection } from '@/components/admin/ArchivesSection';
import { AuditLogsSection } from '@/components/admin/AuditLogsSection';
import { OverviewSection } from '@/components/admin/merged/OverviewSection';
import { FeedIntelligenceMerged, AIMerged } from '@/components/admin/merged/IntelligenceSections';
import { SecurityMerged } from '@/components/admin/merged/SecurityMerged';
import { motion, AnimatePresence } from 'framer-motion';

const NAV_GROUPS = [
  {
    label: 'Vue',
    items: [
      { key: 'overview', label: "Vue d'ensemble", icon: LayoutDashboard },
      { key: 'stats', label: 'Statistiques', icon: BarChart3 },
    ],
  },
  {
    label: 'Gestion',
    items: [
      { key: 'users', label: 'Utilisateurs', icon: Users },
      { key: 'posts', label: 'Publications', icon: FileText },
      { key: 'reports', label: 'Signalements', icon: Flag },
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
      { key: 'feed_intelligence', label: 'Feed IA', icon: Sparkles },
      { key: 'ai', label: 'IA & Zeus', icon: Brain },
    ],
  },
  {
    label: 'Sécurité',
    items: [
      { key: 'security', label: 'Sécurité', icon: ShieldAlert },
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

type AdminSection =
  | 'overview' | 'stats'
  | 'users' | 'posts' | 'reports' | 'verifications' | 'archives'
  | 'subscriptions'
  | 'feed_intelligence' | 'ai'
  | 'security' | 'audit_logs'
  | 'settings';

export default function Admin() {
  const [section, setSection] = useState<AdminSection>('overview');
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
      <AppLayout>
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
      case 'overview': return <OverviewSection />;
      case 'stats': return <StatsSection />;
      case 'users': return <UsersSection />;
      case 'posts': return <PostsSection />;
      case 'reports': return <ReportsSection />;
      case 'verifications': return <VerificationsSection />;
      case 'archives': return <ArchivesSection />;
      case 'subscriptions': return <SubscriptionsSection />;
      case 'feed_intelligence': return <FeedIntelligenceMerged />;
      case 'ai': return <AIMerged />;
      case 'security': return <SecurityMerged />;
      case 'audit_logs': return <AuditLogsSection />;
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
    <AppLayout>
      <div className="flex min-h-[calc(100vh-4rem)]">
        {/* Desktop Sidebar */}
        <aside className="w-56 shrink-0 border-r border-border/40 bg-card/30 backdrop-blur-xl hidden lg:flex flex-col">
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
        <div className="lg:hidden fixed top-[4rem] left-0 right-0 z-30 bg-background/70 backdrop-blur-xl border-b border-border/40 px-4 py-2.5 flex items-center justify-between">
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
        <main className="flex-1 overflow-auto">
          <div className="p-4 lg:p-6 lg:pt-6 pt-16 max-w-7xl mx-auto">
            {renderSection()}
          </div>
        </main>
      </div>
    </AppLayout>
  );
}
