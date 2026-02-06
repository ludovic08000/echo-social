import { useState, useRef, useEffect } from 'react';
import { ArrowLeft, LogOut, Camera, ChevronRight, Users, FileText, Shield, Bell, User, Download, Trash2, Palette, Heart, Brain, Accessibility } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { useProfile, useUpdateProfile } from '@/hooks/useProfile';
import { supabase } from '@/integrations/supabase/client';
import { AppLayout } from '@/components/AppLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { NotificationSettingsPanel } from '@/components/NotificationSettingsPanel';
import { PrivacySettingsPanel } from '@/components/settings/PrivacySettingsPanel';
import { MyGroupsList } from '@/components/settings/MyGroupsList';
import { MyPagesList } from '@/components/settings/MyPagesList';
import { AppearanceSettingsPanel } from '@/components/settings/AppearanceSettingsPanel';
import { WellbeingSettingsPanel } from '@/components/settings/WellbeingSettingsPanel';
import { ContentPreferencesPanel } from '@/components/settings/ContentPreferencesPanel';
import { AccessibilitySettingsPanel } from '@/components/settings/AccessibilitySettingsPanel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

export default function Settings() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { t } = useTranslation();
  const { data: profile } = useProfile();
  const updateProfile = useUpdateProfile();
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [activeTab, setActiveTab] = useState('profile');

  useEffect(() => {
    if (profile) {
      setName(profile.name || '');
      setBio(profile.bio || '');
    }
  }, [profile]);

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    if (file.size > 2 * 1024 * 1024) {
      toast({ title: t('settings.imageTooLarge'), description: t('settings.maxSize'), variant: 'destructive' });
      return;
    }

    setIsUploading(true);
    try {
      const fileExt = file.name.split('.').pop();
      const filePath = `${user.id}/avatar.${fileExt}`;
      const { error: uploadError } = await supabase.storage.from('avatars').upload(filePath, file, { upsert: true });
      if (uploadError) throw uploadError;
      const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(filePath);
      await updateProfile.mutateAsync({ avatar_url: urlData.publicUrl + '?t=' + Date.now() });
      toast({ title: t('settings.photoUpdated') });
    } catch (error) {
      toast({ title: t('common.error'), variant: 'destructive' });
    } finally {
      setIsUploading(false);
    }
  };

  const handleSave = async () => {
    try {
      await updateProfile.mutateAsync({ name, bio });
      toast({ title: t('settings.profileUpdated') });
    } catch (error) {
      toast({ title: t('common.error'), variant: 'destructive' });
    }
  };

  const handleLogout = async () => {
    await signOut();
    navigate('/');
  };

  const tabs = [
    { id: 'profile', label: t('settings.profile'), icon: User },
    { id: 'appearance', label: t('settings.appearance'), icon: Palette },
    { id: 'wellbeing', label: t('settings.wellbeing'), icon: Heart },
    { id: 'content', label: t('settings.content'), icon: Brain },
    { id: 'accessibility', label: t('settings.accessibility'), icon: Accessibility },
    { id: 'groups', label: t('settings.groups'), icon: Users },
    { id: 'pages', label: t('settings.pages'), icon: FileText },
    { id: 'privacy', label: t('settings.privacy'), icon: Shield },
    { id: 'notifications', label: t('settings.notifications'), icon: Bell },
  ];

  return (
    <AppLayout>
      <div className="px-4 py-2">
        <header className="flex items-center gap-3 mb-5">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="h-8 w-8 rounded-full">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <h1 className="text-lg font-bold tracking-tight">{t('settings.title')}</h1>
        </header>

        <div className="flex gap-1.5 mb-5 overflow-x-auto pb-1 scrollbar-hide -mx-4 px-4">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-medium whitespace-nowrap transition-all duration-200',
                activeTab === tab.id
                  ? 'bg-primary text-primary-foreground shadow-premium-gold'
                  : 'bg-secondary/50 text-muted-foreground hover:bg-secondary active:bg-secondary'
              )}
            >
              <tab.icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'profile' && (
          <div className="space-y-4 animate-fade-in">
            <section className="premium-card p-5">
              <div className="flex items-center gap-4">
                <div className="relative">
                  <UserAvatar src={profile?.avatar_url} alt={profile?.name} size="xl" />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                    className="absolute bottom-0 right-0 w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center border-2 border-background hover:bg-primary/90 transition-all duration-200"
                  >
                    <Camera className="w-3 h-3" />
                  </button>
                  <input type="file" ref={fileInputRef} onChange={handleAvatarChange} accept="image/*" className="hidden" />
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-sm truncate">{profile?.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
                </div>
              </div>
            </section>

            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4">{t('settings.information')}</h2>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="name" className="text-xs">{t('signup.name')}</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="rounded-xl h-10 text-sm bg-secondary/40 border-border/30 focus:bg-background"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bio" className="text-xs">{t('settings.bio')}</Label>
                  <Textarea
                    id="bio"
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    placeholder={t('settings.bioPlaceholder')}
                    className="rounded-xl text-sm min-h-[80px] resize-none bg-secondary/40 border-border/30 focus:bg-background"
                  />
                </div>
                <Button
                  onClick={handleSave}
                  disabled={updateProfile.isPending}
                  size="sm"
                  className="premium-button h-9 text-xs w-full"
                >
                  {updateProfile.isPending ? t('settings.saving') : t('settings.saveChanges')}
                </Button>
              </div>
            </section>

            <section className="premium-card overflow-hidden">
              <h2 className="text-sm font-semibold px-5 pt-5 pb-3">{t('settings.account')}</h2>
              <div className="divide-y divide-border/30">
                {[
                  { icon: Download, label: t('settings.downloadData') },
                  { icon: Shield, label: t('settings.changePassword') },
                ].map((item) => (
                  <button key={item.label} className="w-full flex items-center justify-between px-5 py-3.5 text-sm hover:bg-secondary/40 transition-colors">
                    <div className="flex items-center gap-3">
                      <item.icon className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm">{item.label}</span>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </button>
                ))}
              </div>
            </section>

            <section className="premium-card p-5 border-destructive/10">
              <h2 className="text-sm font-semibold text-destructive mb-3">{t('settings.dangerZone')}</h2>
              <div className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleLogout}
                  className="w-full h-9 rounded-xl text-xs border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground"
                >
                  <LogOut className="w-3.5 h-3.5 mr-1.5" />
                  {t('settings.logout')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full h-9 rounded-xl text-xs border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                  {t('settings.deleteAccount')}
                </Button>
              </div>
            </section>
          </div>
        )}

        {activeTab === 'appearance' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <Palette className="w-4 h-4 text-primary" />
                {t('appearance.title')}
              </h2>
              <AppearanceSettingsPanel />
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
      </div>
    </AppLayout>
  );
}
