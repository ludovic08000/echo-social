import { useState, useRef, useEffect } from 'react';
import { ArrowLeft, LogOut, Camera, ChevronRight, Users, FileText, Shield, Bell, User, Download, Trash2, Palette, Heart, Brain, Accessibility } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
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
      toast({ title: 'Image trop volumineuse', description: 'Taille max : 2 Mo', variant: 'destructive' });
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
      toast({ title: 'Photo mise à jour !' });
    } catch (error) {
      toast({ title: 'Erreur', description: 'Impossible de mettre à jour la photo', variant: 'destructive' });
    } finally {
      setIsUploading(false);
    }
  };

  const handleSave = async () => {
    try {
      await updateProfile.mutateAsync({ name, bio });
      toast({ title: 'Profil mis à jour !' });
    } catch (error) {
      toast({ title: 'Erreur', description: 'Impossible de mettre à jour le profil', variant: 'destructive' });
    }
  };

  const handleLogout = async () => {
    await signOut();
    navigate('/');
  };

  const tabs = [
    { id: 'profile', label: 'Profil', icon: User },
    { id: 'appearance', label: 'Apparence', icon: Palette },
    { id: 'wellbeing', label: 'Bien-être', icon: Heart },
    { id: 'content', label: 'Contenu & IA', icon: Brain },
    { id: 'accessibility', label: 'Accès', icon: Accessibility },
    { id: 'groups', label: 'Groupes', icon: Users },
    { id: 'pages', label: 'Pages', icon: FileText },
    { id: 'privacy', label: 'Vie privée', icon: Shield },
    { id: 'notifications', label: 'Notifs', icon: Bell },
  ];

  return (
    <AppLayout>
      <div className="px-4 py-2">
        {/* Header */}
        <header className="flex items-center gap-3 mb-5">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="h-8 w-8 rounded-full">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <h1 className="text-lg font-bold tracking-tight">Paramètres</h1>
        </header>

        {/* Tab navigation - pill style */}
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

        {/* Profile Tab */}
        {activeTab === 'profile' && (
          <div className="space-y-4 animate-fade-in">
            {/* Profile Card */}
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

            {/* Edit Info */}
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4">Informations</h2>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="name" className="text-xs">Nom</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="rounded-xl h-10 text-sm bg-secondary/40 border-border/30 focus:bg-background"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bio" className="text-xs">Bio</Label>
                  <Textarea
                    id="bio"
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    placeholder="Parlez-nous de vous…"
                    className="rounded-xl text-sm min-h-[80px] resize-none bg-secondary/40 border-border/30 focus:bg-background"
                  />
                </div>
                <Button
                  onClick={handleSave}
                  disabled={updateProfile.isPending}
                  size="sm"
                  className="premium-button h-9 text-xs w-full"
                >
                  {updateProfile.isPending ? 'Enregistrement…' : 'Enregistrer les modifications'}
                </Button>
              </div>
            </section>

            {/* Account Actions */}
            <section className="premium-card overflow-hidden">
              <h2 className="text-sm font-semibold px-5 pt-5 pb-3">Compte</h2>
              <div className="divide-y divide-border/30">
                {[
                  { icon: Download, label: 'Télécharger mes données' },
                  { icon: Shield, label: 'Changer le mot de passe' },
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

            {/* Danger Zone */}
            <section className="premium-card p-5 border-destructive/10">
              <h2 className="text-sm font-semibold text-destructive mb-3">Zone de danger</h2>
              <div className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleLogout}
                  className="w-full h-9 rounded-xl text-xs border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground"
                >
                  <LogOut className="w-3.5 h-3.5 mr-1.5" />
                  Se déconnecter
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full h-9 rounded-xl text-xs border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                  Supprimer mon compte
                </Button>
              </div>
            </section>
          </div>
        )}

        {/* Appearance Tab */}
        {activeTab === 'appearance' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <Palette className="w-4 h-4 text-primary" />
                Personnalisation visuelle
              </h2>
              <AppearanceSettingsPanel />
            </section>
          </div>
        )}

        {/* Wellbeing Tab */}
        {activeTab === 'wellbeing' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <Heart className="w-4 h-4 text-primary" />
                Bien-être numérique
              </h2>
              <WellbeingSettingsPanel />
            </section>
          </div>
        )}

        {/* Content & AI Tab */}
        {activeTab === 'content' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <Brain className="w-4 h-4 text-primary" />
                Contenu & Intelligence artificielle
              </h2>
              <ContentPreferencesPanel />
            </section>
          </div>
        )}

        {/* Accessibility Tab */}
        {activeTab === 'accessibility' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <Accessibility className="w-4 h-4 text-primary" />
                Accessibilité & Raccourcis
              </h2>
              <AccessibilitySettingsPanel />
            </section>
          </div>
        )}

        {/* Groups Tab */}
        {activeTab === 'groups' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4">Mes groupes</h2>
              <MyGroupsList />
            </section>
          </div>
        )}

        {/* Pages Tab */}
        {activeTab === 'pages' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4">Mes pages</h2>
              <MyPagesList />
            </section>
          </div>
        )}

        {/* Privacy Tab */}
        {activeTab === 'privacy' && (
          <div className="animate-fade-in">
            <section className="premium-card p-5">
              <h2 className="text-sm font-semibold mb-4">Paramètres de confidentialité</h2>
              <PrivacySettingsPanel />
            </section>
          </div>
        )}

        {/* Notifications Tab */}
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
