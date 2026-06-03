import { useState } from 'react';
import { KeyBackupPanel } from '@/components/KeyBackupPanel';
import { ArchiveBackupToggle } from '@/components/settings/ArchiveBackupToggle';
import { Shield, Eye, MessageCircle, Heart, Search, BarChart3, Ghost, Globe, Lock, Trash2, AlertTriangle, KeyRound } from 'lucide-react';
import { usePrivacySettings, useUpdatePrivacySettings } from '@/hooks/usePrivacySettings';
import { RestrictedFriendsPanel } from './RestrictedFriendsPanel';
import { AccountDeletionSection, DataExportSection } from './AccountManagementSections';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { useQueryClient } from '@tanstack/react-query';
import { useChatPin, type PinMode } from '@/hooks/useChatPin';

function PurgeFeedSection() {
  const { user } = useAuth();
  const [purging, setPurging] = useState(false);
  const queryClient = useQueryClient();

  const handlePurge = async () => {
    if (!user) return;
    setPurging(true);
    try {
      // Fetch all posts with media to delete from R2
      const { data: posts } = await supabase
        .from('posts')
        .select('id, image_url')
        .eq('user_id', user.id);

      // Delete from DB
      const { error } = await supabase
        .from('posts')
        .delete()
        .eq('user_id', user.id);
      if (error) throw error;

      // Cleanup R2 media in background
      if (posts && posts.length > 0) {
        const { deleteFromR2 } = await import('@/lib/r2');
        const mediaUrls = posts
          .filter(p => p.image_url)
          .map(p => p.image_url as string);
        
        for (const url of mediaUrls) {
          try {
            const path = new URL(url).pathname.replace(/^\//, '');
            if (path) await deleteFromR2(path);
          } catch (e) {
            console.error('R2 cleanup error:', e);
          }
        }
      }

      queryClient.invalidateQueries({ queryKey: ['posts'] });
      queryClient.invalidateQueries({ queryKey: ['user-posts'] });
      
    } catch {
      toast({ title: 'Erreur lors de la purge', variant: 'destructive' });
    } finally {
      setPurging(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <Trash2 className="w-5 h-5 text-destructive" />
        <h3 className="font-semibold">Purger mon feed</h3>
      </div>
      <div className="pl-7">
        <div className="p-4 rounded-xl border border-destructive/20 bg-destructive/5 space-y-3">
          <p className="text-sm text-muted-foreground">
            Supprimer définitivement <strong>toutes vos publications</strong>. Cette action est irréversible.
          </p>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" className="gap-2" disabled={purging}>
                <AlertTriangle className="w-4 h-4" />
                {purging ? 'Suppression…' : 'Supprimer toutes mes publications'}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Êtes-vous sûr ?</AlertDialogTitle>
                <AlertDialogDescription>
                  Toutes vos publications, images et commentaires associés seront supprimés définitivement. Cette action ne peut pas être annulée.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Annuler</AlertDialogCancel>
                <AlertDialogAction onClick={handlePurge} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                  Tout supprimer
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </section>
  );
}

const PIN_MODE_OPTIONS: { value: PinMode; label: string; description: string }[] = [
  { value: 'every_open', label: 'À chaque ouverture', description: 'Demande le PIN chaque fois que vous ouvrez la messagerie (le plus sécurisé)' },
  { value: 'once_per_session', label: 'Une fois par session', description: 'Demande le PIN une seule fois après connexion' },
  { value: 'on_inactivity', label: 'Après inactivité (5 min)', description: 'Re-demande le PIN après 5 minutes sans activité' },
  { value: 'on_return', label: 'Au retour sur l\'app', description: 'Re-demande le PIN quand vous revenez sur le site/l\'app' },
];

function PinModeSection() {
  const pin = useChatPin();

  const handleModeChange = async (mode: PinMode) => {
    const ok = await pin.updatePinMode(mode);
    if (ok) {
      toast({ title: 'Mode PIN mis à jour' });
    } else {
      toast({ title: 'Erreur', description: 'Impossible de mettre à jour le mode', variant: 'destructive' });
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound className="w-5 h-5 text-primary" />
        <h3 className="font-semibold">Code PIN messagerie</h3>
      </div>
      <div className="pl-7 space-y-3">
        {!pin.hasPin ? (
          <div className="p-4 rounded-xl border-2 border-dashed border-border/50 bg-secondary/10 text-center space-y-2">
            <Lock className="w-8 h-8 mx-auto text-muted-foreground/60" />
            <p className="text-sm text-muted-foreground">
              Aucun code PIN configuré. Accédez à la messagerie pour en créer un.
            </p>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Choisissez quand votre code PIN est demandé pour accéder à la messagerie chiffrée.
            </p>
            <div className="grid gap-2">
              {PIN_MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleModeChange(opt.value)}
                  className={`flex flex-col items-start gap-0.5 p-3 rounded-xl border-2 transition-all text-left ${
                    pin.pinMode === opt.value
                      ? 'border-primary bg-primary/10 shadow-sm'
                      : 'border-border/50 bg-secondary/20 hover:bg-secondary/40'
                  }`}
                >
                  <span className={`text-sm font-semibold ${pin.pinMode === opt.value ? 'text-primary' : 'text-foreground'}`}>
                    {opt.label}
                  </span>
                  <span className="text-[11px] text-muted-foreground leading-snug">
                    {opt.description}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

const VISIBILITY_OPTIONS = [
  { value: 'public', label: 'Tout le monde' },
  { value: 'friends', label: 'Amis uniquement' },
  { value: 'private', label: 'Personne' },
];

const ACCESS_OPTIONS = [
  { value: 'everyone', label: 'Tout le monde' },
  { value: 'friends', label: 'Amis uniquement' },
  { value: 'nobody', label: 'Personne' },
];

export function PrivacySettingsPanel() {
  const { data: settings, isLoading } = usePrivacySettings();
  const updateSettings = useUpdatePrivacySettings();

  const handleUpdate = async (key: string, value: string | boolean) => {
    try {
      await updateSettings.mutateAsync({ [key]: value });
      toast({ title: 'Paramètre mis à jour' });
    } catch {
      toast({
        title: 'Erreur',
        description: 'Impossible de mettre à jour le paramètre',
        variant: 'destructive',
      });
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (!settings) return null;

  return (
    <div className="space-y-8">
      {/* Ghost Mode */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Ghost className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">Mode Fantôme</h3>
        </div>
        <div className="pl-7">
          <div className="flex items-center justify-between p-4 rounded-xl bg-gradient-to-r from-primary/5 to-primary/10 border border-primary/20">
            <div className="space-y-1">
              <Label className="text-sm font-medium">Activer le mode fantôme</Label>
              <p className="text-xs text-muted-foreground">
                Naviguez de façon invisible : pas de « vu », pas de statut en ligne, aucune trace de lecture.
              </p>
            </div>
            <Switch
              checked={(settings as any).ghost_mode ?? false}
              onCheckedChange={(v) => handleUpdate('ghost_mode', v)}
            />
          </div>
        </div>
      </section>

      {/* Account Mode: Public / Private */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          {settings.profile_visibility === 'public' ? (
            <Globe className="w-5 h-5 text-primary" />
          ) : (
            <Lock className="w-5 h-5 text-primary" />
          )}
          <h3 className="font-semibold">Mode du compte</h3>
        </div>
        <div className="pl-7 grid grid-cols-2 gap-3">
          <button
            onClick={() => {
              handleUpdate('profile_visibility', 'public');
              handleUpdate('posts_visibility', 'public');
              handleUpdate('friends_list_visibility', 'public');
            }}
            className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all h-full ${
              settings.profile_visibility === 'public'
                ? 'border-primary bg-primary/10 shadow-sm'
                : 'border-border/50 bg-secondary/20 hover:bg-secondary/40'
            }`}
          >
            <Globe className={`w-6 h-6 flex-shrink-0 ${settings.profile_visibility === 'public' ? 'text-primary' : 'text-muted-foreground'}`} />
            <span className="text-sm font-semibold">Public</span>
            <p className="text-[11px] text-muted-foreground text-center leading-snug">
              Tout le monde peut voir votre profil, feed et amis
            </p>
          </button>
          <button
            onClick={() => {
              handleUpdate('profile_visibility', 'friends');
              handleUpdate('posts_visibility', 'friends');
              handleUpdate('friends_list_visibility', 'friends');
            }}
            className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all h-full ${
              settings.profile_visibility === 'friends'
                ? 'border-primary bg-primary/10 shadow-sm'
                : 'border-border/50 bg-secondary/20 hover:bg-secondary/40'
            }`}
          >
            <Lock className={`w-6 h-6 flex-shrink-0 ${settings.profile_visibility === 'friends' ? 'text-primary' : 'text-muted-foreground'}`} />
            <span className="text-sm font-semibold">Privé</span>
            <p className="text-[11px] text-muted-foreground text-center leading-snug">
              Seuls vos amis peuvent voir votre profil, feed et amis
            </p>
          </button>
        </div>
      </section>
      {/* Profile Visibility */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Eye className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">Visibilité du profil</h3>
        </div>

        <div className="space-y-4 pl-7">
          <div className="flex items-center justify-between">
            <Label>Qui peut voir mon profil ?</Label>
            <Select
              value={settings.profile_visibility}
              onValueChange={(v) => handleUpdate('profile_visibility', v)}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VISIBILITY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <Label>Qui peut voir mes publications ?</Label>
            <Select
              value={settings.posts_visibility}
              onValueChange={(v) => handleUpdate('posts_visibility', v)}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VISIBILITY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <Label>Qui peut voir ma liste d'amis ?</Label>
            <Select
              value={settings.friends_list_visibility}
              onValueChange={(v) => handleUpdate('friends_list_visibility', v)}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VISIBILITY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <Label>Qui peut voir mon statut en ligne ?</Label>
            <Select
              value={settings.online_status_visibility}
              onValueChange={(v) => handleUpdate('online_status_visibility', v)}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCESS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <Label>Qui peut écrire sur mon mur anonyme ?</Label>
            <Select
              value={(settings as any).wall_visibility || 'friends'}
              onValueChange={(v) => handleUpdate('wall_visibility', v)}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCESS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>

      {/* Interactions */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <MessageCircle className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">Interactions</h3>
        </div>

        <div className="space-y-4 pl-7">
          <div className="flex items-center justify-between">
            <Label>Qui peut m'envoyer des messages ?</Label>
            <Select
              value={settings.messages_allowed}
              onValueChange={(v) => handleUpdate('messages_allowed', v)}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCESS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <Label>Qui peut commenter mes posts ?</Label>
            <Select
              value={settings.comments_allowed}
              onValueChange={(v) => handleUpdate('comments_allowed', v)}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCESS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <Label>Qui peut voir mes likes ?</Label>
            <Select
              value={settings.likes_visibility}
              onValueChange={(v) => handleUpdate('likes_visibility', v)}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VISIBILITY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>

      {/* Data & Privacy */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">Données et confidentialité</h3>
        </div>

        <div className="space-y-4 pl-7">
          <div className="flex items-center justify-between p-4 rounded-xl bg-secondary/50">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Search className="w-4 h-4" />
                <Label>Indexation par les moteurs de recherche</Label>
              </div>
              <p className="text-sm text-muted-foreground">
                Permettre à Google de référencer mon profil
              </p>
            </div>
            <Switch
              checked={settings.search_engine_indexing}
              onCheckedChange={(v) => handleUpdate('search_engine_indexing', v)}
            />
          </div>

          <div className="flex items-center justify-between p-4 rounded-xl bg-secondary/50">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4" />
                <Label>Statistiques d'utilisation</Label>
              </div>
              <p className="text-sm text-muted-foreground">
                Partager des données anonymes pour améliorer l'app
              </p>
            </div>
            <Switch
              checked={settings.analytics_enabled}
              onCheckedChange={(v) => handleUpdate('analytics_enabled', v)}
            />
          </div>

          <div className="flex items-center justify-between p-4 rounded-xl bg-secondary/50">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4" />
                <Label>Personnalisation IA du fil</Label>
              </div>
              <p className="text-sm text-muted-foreground">
                Autoriser l'envoi d'extraits courts et anonymisés de mes publications à l'IA pour
                personnaliser mon fil. Désactivable à tout moment — les signaux agrégés (likes,
                temps de lecture) restent utilisés.
              </p>
            </div>
            <Switch
              checked={settings.ai_personalization_enabled !== false}
              onCheckedChange={(v) => handleUpdate('ai_personalization_enabled', v)}
            />
          </div>

          <div className="flex items-center justify-between p-4 rounded-xl bg-secondary/50">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Lock className="w-4 h-4" />
                <Label>Partage de signaux avec l'IA</Label>
              </div>
              <p className="text-sm text-muted-foreground">
                Lorsque cette option est désactivée, aucun extrait identifiant ni signal personnel
                n'est transmis aux services IA externes (modération, recommandations). Les
                fonctionnalités IA continuent de fonctionner avec des données strictement minimales.
              </p>
            </div>
            <Switch
              checked={settings.ai_data_sharing_enabled !== false}
              onCheckedChange={(v) => handleUpdate('ai_data_sharing_enabled', v)}
            />
          </div>
        </div>
      </section>

      {/* PIN Mode Settings */}
      <PinModeSection />

      {/* Purge Feed */}
      <PurgeFeedSection />

      {/* Restricted Friends */}
      <section className="space-y-4">
        <RestrictedFriendsPanel />
      </section>

      {/* E2EE Key Backup & Transfer */}
      <KeyBackupPanel />

      {/* Conversation-level encrypted history backup */}
      <ArchiveBackupToggle />

      {/* Data Export */}
      <DataExportSection />

      {/* Account Deletion */}
      <AccountDeletionSection />
    </div>
  );
}
