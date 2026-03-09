import { Shield, Eye, MessageCircle, Heart, Search, BarChart3, Ghost } from 'lucide-react';
import { usePrivacySettings, useUpdatePrivacySettings } from '@/hooks/usePrivacySettings';
import { RestrictedFriendsPanel } from './RestrictedFriendsPanel';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';

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
        </div>
      </section>
    </div>
  );
}
