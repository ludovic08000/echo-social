import { useEffect } from 'react';
import { useUXMode } from '@/hooks/useUXMode';
import { ArrowLeft, Palette, Heart, Brain, Accessibility, Smartphone } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '@/lib/i18n';
import { AppLayout } from '@/components/AppLayout';
import { SettingsMenuGrid } from '@/components/settings/SettingsMenuGrid';
import { SettingsProfileTab } from '@/components/settings/SettingsProfileTab';
import { NotificationSettingsPanel } from '@/components/NotificationSettingsPanel';
import { PrivacySettingsPanel } from '@/components/settings/PrivacySettingsPanel';
import { AppearanceSettingsPanel } from '@/components/settings/AppearanceSettingsPanel';
import { WellbeingSettingsPanel } from '@/components/settings/WellbeingSettingsPanel';
import { ContentPreferencesPanel } from '@/components/settings/ContentPreferencesPanel';
import { AccessibilitySettingsPanel } from '@/components/settings/AccessibilitySettingsPanel';
import { DevicesPanel } from '@/components/settings/DevicesPanel';
import { IdentityRotationPanel } from '@/components/settings/IdentityRotationPanel';
import { MessagingPinGate } from '@/components/MessagingPinGate';
import { Button } from '@/components/ui/button';

export default function Settings() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation();
  const { mode: uxMode } = useUXMode();
  const requestedTab = searchParams.get('tab');
  const validTabs = new Set([
    'profile', 'appearance', 'wellbeing', 'content', 'accessibility',
    'privacy', 'notifications', 'devices',
  ]);
  const activeTab = requestedTab && validTabs.has(requestedTab) ? requestedTab : null;

  useEffect(() => {
    if (!activeTab || !window.location.hash) return;
    const targetId = decodeURIComponent(window.location.hash.slice(1));
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({ block: 'start' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab]);

  const setActiveTab = (tab: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (tab) next.set('tab', tab);
    else next.delete('tab');
    setSearchParams(next);
  };

  const handleBack = () => {
    if (activeTab) {
      setActiveTab(null);
    } else {
      navigate(-1);
    }
  };

  const sectionTitle = activeTab
    ? t(`settings.${activeTab === 'content' ? 'content' : activeTab}`)
    : t('settings.title');

  return (
    <AppLayout>
      <div className="px-4 py-2 max-w-2xl mx-auto">
        <header className="flex items-center gap-3 mb-5">
          <Button variant="ghost" size="icon" onClick={handleBack} className="h-9 w-9 rounded-xl">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <h1 className="text-lg font-bold tracking-tight flex-1">{sectionTitle}</h1>
        </header>

        {!activeTab && (
          <SettingsMenuGrid activeTab="" onTabChange={setActiveTab} />
        )}

        {activeTab === 'profile' && <SettingsProfileTab />}

        {activeTab === 'appearance' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <Palette className="w-4 h-4 text-primary" />
                {t('appearance.title')}
              </h2>
              <AppearanceSettingsPanel key={uxMode} />
            </section>
          </div>
        )}

        {activeTab === 'wellbeing' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <Heart className="w-4 h-4 text-primary" />
                {t('wellbeing.title')}
              </h2>
              <WellbeingSettingsPanel />
            </section>
          </div>
        )}

        {activeTab === 'content' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <Brain className="w-4 h-4 text-primary" />
                {t('content.title')}
              </h2>
              <ContentPreferencesPanel />
            </section>
          </div>
        )}

        {activeTab === 'accessibility' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <Accessibility className="w-4 h-4 text-primary" />
                {t('access.title')}
              </h2>
              <AccessibilitySettingsPanel />
            </section>
          </div>
        )}


        {activeTab === 'privacy' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4">{t('settings.privacySettings')}</h2>
              <PrivacySettingsPanel />
            </section>
          </div>
        )}

        {activeTab === 'notifications' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <NotificationSettingsPanel />
            </section>
          </div>
        )}

        {activeTab === 'devices' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-primary" />
                Appareils connectés
              </h2>
              <MessagingPinGate>
                <div className="space-y-5">
                  <DevicesPanel />
                  <IdentityRotationPanel />
                </div>
              </MessagingPinGate>
            </section>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
