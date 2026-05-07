import { useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { UserAvatar } from '@/components/UserAvatar';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { Phone, Video, Search } from 'lucide-react';
import { toast } from 'sonner';
import { startGroupCall } from '@/lib/calls/groupCall';

interface FriendRow {
  user_id: string;
  name: string | null;
  avatar_url: string | null;
}

interface AddParticipantSheetProps {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  /** Pre-selected (e.g. the current 1-to-1 peer) */
  prefilled?: string[];
  onCallStarted?: (callId: string, roomId: string, callKey: string, callType: 'audio' | 'video') => void;
}

export function AddParticipantSheet({
  open,
  onClose,
  conversationId,
  prefilled = [],
  onCallStarted,
}: AddParticipantSheetProps) {
  const { user } = useAuth();
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(prefilled));
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!open || !user) return;
    setSelected(new Set(prefilled));
    setLoading(true);

    (async () => {
      // Reuse "friendships" table if present, else fall back to recent message peers.
      const { data: prof } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .neq('user_id', user.id)
        .order('updated_at', { ascending: false })
        .limit(50);
      setFriends((prof as FriendRow[]) ?? []);
      setLoading(false);
    })();
  }, [open, user]);

  const filtered = friends.filter(f => {
    const q = search.toLowerCase();
    if (!q) return true;
    return (f.name ?? '').toLowerCase().includes(q);
  });

  const toggle = (uid: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else if (next.size < 7) next.add(uid);
      else toast.error('Maximum 7 invités (8 participants au total)');
      return next;
    });
  };

  const start = async (callType: 'audio' | 'video') => {
    if (selected.size === 0) {
      toast.error('Sélectionne au moins une personne');
      return;
    }
    setStarting(true);
    try {
      const result = await startGroupCall({
        conversationId,
        inviteeIds: Array.from(selected),
        callType,
      });
      onCallStarted?.(result.callId, result.roomId, result.callKey, callType);
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? "Impossible de lancer l'appel");
    } finally {
      setStarting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="bottom" className="rounded-t-3xl max-h-[80vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Appel de groupe</SheetTitle>
        </SheetHeader>

        <div className="relative mt-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Rechercher…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        <p className="text-xs text-muted-foreground mt-3">
          {selected.size} / 7 invités sélectionnés
        </p>

        <div className="space-y-1 mt-3">
          {loading && <p className="text-center text-sm text-muted-foreground py-6">Chargement…</p>}
          {!loading && filtered.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-6">Aucun contact</p>
          )}
          {filtered.map(f => (
            <button
              key={f.user_id}
              onClick={() => toggle(f.user_id)}
              className="w-full flex items-center gap-3 p-2 rounded-xl hover:bg-muted/50 transition"
            >
              <Checkbox checked={selected.has(f.user_id)} onCheckedChange={() => toggle(f.user_id)} />
              <UserAvatar src={f.avatar_url} alt={f.name ?? ''} size="sm" />
              <div className="flex-1 text-left">
                <p className="text-sm font-medium">{f.name ?? f.username ?? 'Sans nom'}</p>
                {f.username && <p className="text-xs text-muted-foreground">@{f.username}</p>}
              </div>
            </button>
          ))}
        </div>

        <div className="sticky bottom-0 left-0 right-0 bg-background pt-4 pb-2 flex gap-3">
          <Button
            disabled={starting || selected.size === 0}
            onClick={() => start('audio')}
            className="flex-1 rounded-full"
            variant="secondary"
          >
            <Phone className="w-4 h-4 mr-2" />
            Audio
          </Button>
          <Button
            disabled={starting || selected.size === 0}
            onClick={() => start('video')}
            className="flex-1 rounded-full"
          >
            <Video className="w-4 h-4 mr-2" />
            Vidéo
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
