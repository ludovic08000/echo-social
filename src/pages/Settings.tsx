import { useState } from 'react';
import { useUXMode } from '@/hooks/useUXMode';
import { ArrowLeft, Palette, Heart, Brain, Accessibility, Baby, Smartphone } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '@/lib/i18n';
import { AppLayout } from '@/components/AppLayout';
import { SettingsMenuGrid } from '@/components/settings/SettingsMenuGrid';
import { SettingsProfileTab } from '@/components/settings/SettingsProfileTab';
import { NotificationSettingsPanel } from '@/components/NotificationSettingsPanel';
import { PrivacySettingsPanel } from '@/components/settings/PrivacySettingsPanel';
import { MyGroupsList } from '@/components/settings/MyGroupsList';
import { MyPagesList } from '@/components/settings/MyPagesList';
import { AppearanceSettingsPanel } from '@/components/settings/AppearanceSettingsPanel';
import { WellbeingSettingsPanel } from '@/components/settings/WellbeingSettingsPanel';
import { ContentPreferencesPanel } from '@/components/settings/ContentPreferencesPanel';
import { AccessibilitySettingsPanel } from '@/components/settings/AccessibilitySettingsPanel';
import { ParentalControlPanel } from '@/components/settings/ParentalControlPanel';
import { DevicesPanel } from '@/components/settings/DevicesPanel';
import { MessagingPinGate } from '@/components/MessagingPinGate';
import { Button } from '@/components/ui/button';

export default function Settings() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const { mode: uxMode } = useUXMode();

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

        {activeTab === 'groups' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4">{t('settings.myGroups')}</h2>
              <MyGroupsList />
            </section>
          </div>
        )}

        {activeTab === 'pages' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4">{t('settings.myPages')}</h2>
              <MyPagesList />
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

        {activeTab === 'parental' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <Baby className="w-4 h-4 text-pink-500" />
                Contrôle parental
              </h2>
              <ParentalControlPanel />
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
                <DevicesPanel />
              </MessagingPinGate>
            </section>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
