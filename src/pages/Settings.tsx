import { useState, useRef, useEffect } from 'react';
import { ArrowLeft, Moon, Sun, LogOut, Camera, ChevronRight, Users, FileText, Shield, Bell, User, Download, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useProfile, useUpdateProfile } from '@/hooks/useProfile';
import { useTheme } from '@/hooks/useTheme';
import { supabase } from '@/integrations/supabase/client';
import { AppLayout } from '@/components/AppLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { NotificationSettingsPanel } from '@/components/NotificationSettingsPanel';
import { PrivacySettingsPanel } from '@/components/settings/PrivacySettingsPanel';
import { MyGroupsList } from '@/components/settings/MyGroupsList';
import { MyPagesList } from '@/components/settings/MyPagesList';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

export default function Settings() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { data: profile } = useProfile();
  const updateProfile = useUpdateProfile();
  const { theme, toggleTheme } = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [activeTab, setActiveTab] = useState('profile');

  // Update form when profile loads
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
      toast({
        title: 'Image trop volumineuse',
        description: 'La taille maximale est de 2 Mo',
        variant: 'destructive',
      });
      return;
    }

    setIsUploading(true);

    try {
      const fileExt = file.name.split('.').pop();
      const filePath = `${user.id}/avatar.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(filePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from('avatars')
        .getPublicUrl(filePath);

      await updateProfile.mutateAsync({ avatar_url: urlData.publicUrl + '?t=' + Date.now() });

      toast({
        title: 'Photo mise à jour !',
      });
    } catch (error) {
      toast({
        title: 'Erreur',
        description: 'Impossible de mettre à jour la photo',
        variant: 'destructive',
      });
    } finally {
      setIsUploading(false);
    }
  };

  const handleSave = async () => {
    try {
      await updateProfile.mutateAsync({ name, bio });
      toast({
        title: 'Profil mis à jour !',
      });
    } catch (error) {
      toast({
        title: 'Erreur',
        description: 'Impossible de mettre à jour le profil',
        variant: 'destructive',
      });
    }
  };

  const handleLogout = async () => {
    await signOut();
    navigate('/');
  };

  const tabs = [
    { id: 'profile', label: 'Profil', icon: User },
    { id: 'groups', label: 'Groupes', icon: Users },
    { id: 'pages', label: 'Pages', icon: FileText },
    { id: 'privacy', label: 'Confidentialité', icon: Shield },
    { id: 'notifications', label: 'Notifications', icon: Bell },
  ];

  return (
    <AppLayout>
      <header className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="font-display text-xl font-semibold">Paramètres</h1>
      </header>

      {/* Tab navigation */}
      <div className="flex gap-2 mb-6 overflow-x-auto pb-2 -mx-4 px-4 scrollbar-hide">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors',
              activeTab === tab.id
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary/50 text-muted-foreground hover:bg-secondary'
            )}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Profile Tab */}
      {activeTab === 'profile' && (
        <div className="space-y-6 animate-fade-in">
          {/* Profile Photo Section */}
          <section className="premium-card p-6">
            <h2 className="font-display font-semibold mb-4">Photo de profil</h2>

            <div className="flex items-center gap-4">
              <div className="relative">
                <UserAvatar src={profile?.avatar_url} alt={profile?.name} size="xl" />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading}
                  className="absolute bottom-0 right-0 w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg hover:opacity-90 transition-all duration-200 hover:scale-105"
                >
                  <Camera className="w-4 h-4" />
                </button>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleAvatarChange}
                  accept="image/*"
                  className="hidden"
                />
              </div>
              <div>
                <p className="font-medium">{profile?.name}</p>
                <p className="text-sm text-muted-foreground">{user?.email}</p>
              </div>
            </div>
          </section>

          {/* Profile Info Section */}
          <section className="premium-card p-6">
            <h2 className="font-display font-semibold mb-4">Informations</h2>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Nom</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="premium-input"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="bio">Bio</Label>
                <Textarea
                  id="bio"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder="Parlez-nous de vous..."
                  className="premium-input min-h-[100px] resize-none"
                />
              </div>

              <Button
                onClick={handleSave}
                disabled={updateProfile.isPending}
                className="premium-button"
              >
                {updateProfile.isPending ? 'Enregistrement...' : 'Enregistrer'}
              </Button>
            </div>
          </section>

          {/* Appearance Section */}
          <section className="premium-card p-6">
            <h2 className="font-display font-semibold mb-4">Apparence</h2>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  {theme === 'dark' ? (
                    <Moon className="w-5 h-5 text-primary" />
                  ) : (
                    <Sun className="w-5 h-5 text-primary" />
                  )}
                </div>
                <div>
                  <p className="font-medium">Mode sombre</p>
                  <p className="text-sm text-muted-foreground">
                    {theme === 'dark' ? 'Activé' : 'Désactivé'}
                  </p>
                </div>
              </div>
              <Switch checked={theme === 'dark'} onCheckedChange={toggleTheme} />
            </div>
          </section>

          {/* Account Section */}
          <section className="premium-card p-6">
            <h2 className="font-display font-semibold mb-4">Compte</h2>

            <div className="space-y-3">
              <button className="w-full flex items-center justify-between p-4 rounded-xl bg-secondary/50 hover:bg-secondary transition-colors">
                <div className="flex items-center gap-3">
                  <Download className="w-5 h-5 text-muted-foreground" />
                  <span className="font-medium">Télécharger mes données</span>
                </div>
                <ChevronRight className="w-5 h-5 text-muted-foreground" />
              </button>
              
              <button className="w-full flex items-center justify-between p-4 rounded-xl bg-secondary/50 hover:bg-secondary transition-colors">
                <span className="font-medium">Changer le mot de passe</span>
                <ChevronRight className="w-5 h-5 text-muted-foreground" />
              </button>
              
              <button className="w-full flex items-center justify-between p-4 rounded-xl bg-secondary/50 hover:bg-secondary transition-colors">
                <span className="font-medium">Sessions actives</span>
                <ChevronRight className="w-5 h-5 text-muted-foreground" />
              </button>
            </div>
          </section>

          {/* Danger Zone */}
          <section className="premium-card p-6 border-destructive/20">
            <h2 className="font-display font-semibold mb-4 text-destructive">Zone de danger</h2>

            <div className="space-y-3">
              <Button
                variant="outline"
                onClick={handleLogout}
                className="w-full border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground"
              >
                <LogOut className="w-4 h-4 mr-2" />
                Se déconnecter
              </Button>

              <Button
                variant="outline"
                className="w-full border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Supprimer mon compte
              </Button>
            </div>
          </section>
        </div>
      )}

      {/* Groups Tab */}
      {activeTab === 'groups' && (
        <div className="animate-fade-in">
          <section className="premium-card p-6">
            <h2 className="font-display font-semibold mb-4">Mes groupes</h2>
            <MyGroupsList />
          </section>
        </div>
      )}

      {/* Pages Tab */}
      {activeTab === 'pages' && (
        <div className="animate-fade-in">
          <section className="premium-card p-6">
            <h2 className="font-display font-semibold mb-4">Mes pages</h2>
            <MyPagesList />
          </section>
        </div>
      )}

      {/* Privacy Tab */}
      {activeTab === 'privacy' && (
        <div className="animate-fade-in">
          <section className="premium-card p-6">
            <h2 className="font-display font-semibold mb-6">Paramètres de confidentialité</h2>
            <PrivacySettingsPanel />
          </section>
        </div>
      )}

      {/* Notifications Tab */}
      {activeTab === 'notifications' && (
        <div className="animate-fade-in">
          <section className="premium-card p-6">
            <NotificationSettingsPanel />
          </section>
        </div>
      )}
    </AppLayout>
  );
}
