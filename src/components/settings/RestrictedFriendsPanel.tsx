import { useState } from 'react';
import { UserX, Plus, Trash2, Eye, MessageCircle, Rss, BookImage } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import {
  useRestrictedFriends,
  useAddRestrictedFriend,
  useUpdateRestrictedFriend,
  useRemoveRestrictedFriend,
} from '@/hooks/useRestrictedFriends';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';

interface FriendProfile {
  user_id: string;
  name: string;
  avatar_url: string | null;
}

function useFriendsList() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['all-friends', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data: friendships } = await supabase
        .from('friendships')
        .select('requester_id, addressee_id')
        .eq('status', 'accepted')
        .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);

      if (!friendships || friendships.length === 0) return [];

      const friendIds = friendships.map(f =>
        f.requester_id === user.id ? f.addressee_id : f.requester_id
      );

      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', friendIds);

      return (profiles || []) as FriendProfile[];
    },
    enabled: !!user,
  });
}

const RESTRICTION_OPTIONS = [
  { key: 'restrict_feed' as const, label: 'Feed / Publications', icon: Rss },
  { key: 'restrict_stories' as const, label: 'Stories', icon: BookImage },
  { key: 'restrict_messages' as const, label: 'Messages', icon: MessageCircle },
  { key: 'restrict_profile' as const, label: 'Profil complet', icon: Eye },
];

export function RestrictedFriendsPanel() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data: restricted, isLoading } = useRestrictedFriends();
  const { data: allFriends } = useFriendsList();
  const addRestricted = useAddRestrictedFriend();
  const updateRestricted = useUpdateRestrictedFriend();
  const removeRestricted = useRemoveRestrictedFriend();

  const restrictedIds = new Set((restricted || []).map(r => r.restricted_user_id));
  const availableFriends = (allFriends || []).filter(f => !restrictedIds.has(f.user_id));

  // Get profile info for restricted friends
  const { data: restrictedProfiles } = useQuery({
    queryKey: ['restricted-profiles', restricted?.map(r => r.restricted_user_id)],
    queryFn: async () => {
      if (!restricted || restricted.length === 0) return [];
      const ids = restricted.map(r => r.restricted_user_id);
      const { data } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', ids);
      return (data || []) as FriendProfile[];
    },
    enabled: !!restricted && restricted.length > 0,
  });

  const profileMap = new Map((restrictedProfiles || []).map(p => [p.user_id, p]));

  const handleAdd = async (friendId: string) => {
    try {
      await addRestricted.mutateAsync(friendId);
      toast({ title: 'Ami restreint ajouté' });
      setDialogOpen(false);
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const handleToggle = async (id: string, key: string, value: boolean) => {
    try {
      await updateRestricted.mutateAsync({ id, updates: { [key]: value } });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await removeRestricted.mutateAsync(id);
      toast({ title: 'Restriction retirée' });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2].map(i => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UserX className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">Amis restreints</h3>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" className="gap-1.5">
              <Plus className="w-3.5 h-3.5" />
              Ajouter
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[70vh]">
            <DialogHeader>
              <DialogTitle>Sélectionner un ami à restreindre</DialogTitle>
            </DialogHeader>
            <div className="space-y-1 max-h-[50vh] overflow-y-auto">
              {availableFriends.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  Aucun ami disponible à restreindre
                </p>
              ) : (
                availableFriends.map(friend => (
                  <button
                    key={friend.user_id}
                    onClick={() => handleAdd(friend.user_id)}
                    className="flex items-center gap-3 w-full p-3 rounded-xl hover:bg-secondary/60 transition-colors"
                  >
                    <UserAvatar src={friend.avatar_url} alt={friend.name} size="sm" />
                    <span className="text-sm font-medium">{friend.name}</span>
                  </button>
                ))
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <p className="text-xs text-muted-foreground">
        Les amis restreints ne verront pas le contenu que vous choisissez de masquer. Ils ne seront pas notifiés.
      </p>

      {(!restricted || restricted.length === 0) && (
        <div className="text-center py-8 rounded-xl bg-secondary/30 border border-border/50">
          <UserX className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">Aucun ami restreint</p>
        </div>
      )}

      <div className="space-y-3">
        {(restricted || []).map(r => {
          const profile = profileMap.get(r.restricted_user_id);
          return (
            <div key={r.id} className="rounded-xl border border-border/50 bg-secondary/20 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <UserAvatar
                    src={profile?.avatar_url || null}
                    alt={profile?.name || '?'}
                    size="sm"
                  />
                  <span className="text-sm font-semibold">{profile?.name || 'Utilisateur'}</span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => handleRemove(r.id)}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {RESTRICTION_OPTIONS.map(opt => (
                  <div
                    key={opt.key}
                    className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-background/60"
                  >
                    <div className="flex items-center gap-2">
                      <opt.icon className="w-3.5 h-3.5 text-muted-foreground" />
                      <Label className="text-xs">{opt.label}</Label>
                    </div>
                    <Switch
                      checked={(r as any)[opt.key]}
                      onCheckedChange={v => handleToggle(r.id, opt.key, v)}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
