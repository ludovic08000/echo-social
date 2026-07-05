import { useRef, useState, useEffect } from 'react';
import { Camera, Download, Shield, ChevronRight, LogOut, Trash2, Music, Phone, AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { useProfile, useUpdateProfile } from '@/hooks/useProfile';
import { useAgeVerification } from '@/hooks/useAgeVerification';
import { supabase } from '@/integrations/supabase/client';
import { getSafeRedirectUrl } from '@/lib/urlUtils';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { toast } from '@/hooks/use-toast';

export function SettingsProfileTab() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { t } = useTranslation();
  const { data: profile } = useProfile();
  const updateProfile = useUpdateProfile();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { verifyAge } = useAgeVerification();

  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [musicUrl, setMusicUrl] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isRequestingDeletion, setIsRequestingDeletion] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  const handleDownloadData = async () => {
    if (!user) return;
    setIsExporting(true);
    try {
      await supabase.auth.refreshSession();
      const { data, error } = await supabase.functions.invoke('data-export', {
        body: { type: 'basic' },
      });
      if (error) throw error;
      if (data?.download_url) {
        const link = document.createElement('a');
        link.href = data.download_url;
        link.download = `forsure-export-${new Date().toISOString().split('T')[0]}.json`;
        link.click();
        toast({ title: 'Export téléchargé avec succès' });
      } else if (data?.message) {
        toast({ title: data.message });
      }
    } catch {
      toast({ title: 'Erreur lors de l\'export', variant: 'destructive' });
    } finally {
      setIsExporting(false);
    }
  };

  const handleChangePassword = async () => {
    if (!user?.email) {
      toast({ title: 'Erreur', description: 'Aucun e-mail associé à ce compte.', variant: 'destructive' });
      return;
    }
    setIsChangingPassword(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(user.email, {
        redirectTo: getSafeRedirectUrl('/reset-password'),
      });
      if (error) throw error;
      // Sign out IMMEDIATELY after requesting password reset from settings
      await signOut();
      toast({
        title: 'E-mail envoyé ✉️',
        description: 'Consultez votre boîte mail pour réinitialiser votre mot de passe.',
      });
      navigate('/login', { replace: true });
    } catch (err) {
      console.error('[Password] Reset email error:', err);
      toast({ title: 'Erreur', description: 'Impossible d\'envoyer l\'e-mail de réinitialisation.', variant: 'destructive' });
    } finally {
      setIsChangingPassword(false);
    }
  };

  useEffect(() => {
    if (profile) {
      setName(profile.name || '');
      setBio(profile.bio || '');
      setMusicUrl(profile.profile_music_url || '');
    }
  }, [profile]);

  // Phone number lives outside the profiles table read path — fetch via RPC
  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase.rpc('get_own_phone_number');
      if (typeof data === 'string') setPhoneNumber(data);
    })();
  }, [user?.id]);

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

      // Background age verification on first photo
      if (!profile?.age_verified) {
        verifyAge(url);
      }
    } catch (error) {
      toast({ title: t('common.error'), variant: 'destructive' });
    } finally {
      setIsUploading(false);
    }
  };

  const handleSave = async () => {
    try {
      await updateProfile.mutateAsync({ name, bio, profile_music_url: musicUrl || null, phone_number: phoneNumber || null } as any);
      toast({ title: t('settings.profileUpdated') });
    } catch (error) {
      toast({ title: t('common.error'), variant: 'destructive' });
    }
  };

  const handleLogout = async () => {
    await signOut();
    navigate('/');
  };

  const handleDeleteAccountRequest = async () => {
    if (!user || deleteConfirmText !== 'SUPPRIMER') return;

    setIsRequestingDeletion(true);
    try {
      const { error } = await supabase
        .from('account_deletion_requests')
        .insert({
          user_id: user.id,
          status: 'pending',
          reason: 'User requested deletion from profile settings',
        } as any);

      if (error) throw error;

      toast({
        title: 'Demande de suppression enregistrée',
        description: 'Votre compte sera supprimé dans 30 jours si vous ne vous reconnectez pas.',
      });

      setDeleteConfirmText('');
      setDeleteDialogOpen(false);
    } catch (error: any) {
      toast({
        title: 'Erreur',
        description: error?.message || 'Impossible de traiter votre demande.',
        variant: 'destructive',
      });
    } finally {
      setIsRequestingDeletion(false);
    }
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
          <div className="space-y-1.5">
            <Label htmlFor="phone" className="text-xs flex items-center gap-1"><Phone className="w-3 h-3" /> Numéro de téléphone</Label>
            <Input
              id="phone"
              type="tel"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+33 6 12 34 56 78"
              className="rounded-xl h-10 text-sm bg-secondary/40 border-border/30 focus:bg-background"
            />
            <p className="text-[10px] text-muted-foreground">Permet à vos contacts de vous retrouver sur Forsure</p>
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
          <button
            onClick={handleDownloadData}
            disabled={isExporting}
            className="w-full flex items-center justify-between px-5 py-3.5 text-sm hover:bg-secondary/40 transition-colors"
          >
            <div className="flex items-center gap-3">
              <Download className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm">{isExporting ? 'Génération…' : t('settings.downloadData')}</span>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </button>
          <button
            onClick={handleChangePassword}
            disabled={isChangingPassword}
            className="w-full flex items-center justify-between px-5 py-3.5 text-sm hover:bg-secondary/40 transition-colors"
          >
            <div className="flex items-center gap-3">
              <Shield className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm">{isChangingPassword ? 'Envoi…' : t('settings.changePassword')}</span>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </button>
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

          <AlertDialog open={deleteDialogOpen} onOpenChange={(open) => {
            setDeleteDialogOpen(open);
            if (!open) setDeleteConfirmText('');
          }}>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="w-full h-9 rounded-xl text-xs border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                {t('settings.deleteAccount')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Supprimer définitivement votre compte ?</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-3">
                    <p>
                      Vos données seront conservées 30 jours. Si vous ne vous reconnectez pas pendant ce délai,
                      votre compte et vos données seront supprimés définitivement.
                    </p>
                    <p className="font-medium text-foreground flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-destructive" />
                      Tapez <strong>SUPPRIMER</strong> pour confirmer.
                    </p>
                    <Input
                      value={deleteConfirmText}
                      onChange={(e) => setDeleteConfirmText(e.target.value)}
                      placeholder="SUPPRIMER"
                    />
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isRequestingDeletion}>Annuler</AlertDialogCancel>
                <Button
                  variant="destructive"
                  onClick={handleDeleteAccountRequest}
                  disabled={deleteConfirmText !== 'SUPPRIMER' || isRequestingDeletion}
                >
                  {isRequestingDeletion ? 'Traitement…' : 'Confirmer la suppression'}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </section>
    </div>
  );
}
