import { useRef, useState, useEffect } from 'react';
import { Camera, Download, Shield, ChevronRight, LogOut, Trash2, Music, Phone } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { useProfile, useUpdateProfile } from '@/hooks/useProfile';
import { supabase } from '@/integrations/supabase/client';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';

export function SettingsProfileTab() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { t } = useTranslation();
  const { data: profile } = useProfile();
  const updateProfile = useUpdateProfile();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [musicUrl, setMusicUrl] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    if (profile) {
      setName(profile.name || '');
      setBio(profile.bio || '');
      setMusicUrl(profile.profile_music_url || '');
      setPhoneNumber((profile as any).phone_number || '');
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
      const { uploadToR2 } = await import('@/lib/r2');
      const { url } = await uploadToR2(file, 'avatars');
      await updateProfile.mutateAsync({ avatar_url: url + '?t=' + Date.now() });
      toast({ title: t('settings.photoUpdated') });
    } catch (error) {
      toast({ title: t('common.error'), variant: 'destructive' });
    } finally {
      setIsUploading(false);
    }
  };

  const handleSave = async () => {
    try {
      await updateProfile.mutateAsync({ name, bio, profile_music_url: musicUrl || null } as any);
      toast({ title: t('settings.profileUpdated') });
    } catch (error) {
      toast({ title: t('common.error'), variant: 'destructive' });
    }
  };

  const handleLogout = async () => {
    await signOut();
    navigate('/');
  };

  return (
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
            <p className="text-xs text-muted-foreground truncate">{user?.email ? user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3') : ''}</p>
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
          <div className="space-y-1.5">
            <Label htmlFor="music" className="text-xs flex items-center gap-1"><Music className="w-3 h-3" /> Playlist d'ambiance (URL)</Label>
            <Input
              id="music"
              value={musicUrl}
              onChange={(e) => setMusicUrl(e.target.value)}
              placeholder="https://exemple.com/musique.mp3"
              className="rounded-xl h-10 text-sm bg-secondary/40 border-border/30 focus:bg-background"
            />
            <p className="text-[10px] text-muted-foreground">Les visiteurs entendront cette musique sur votre profil</p>
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
  );
}
