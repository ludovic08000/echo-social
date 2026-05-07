import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { UserAvatar } from '@/components/UserAvatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { Phone, Video, Search, X, Users } from 'lucide-react';
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
  prefilled?: string[];
  onCallStarted?: (callId: string, roomId: string, callKey: string, callType: 'audio' | 'video') => void;
}

const MAX_INVITEES = 7;

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
    setSearch('');
    setLoading(true);

    (async () => {
      try {
        // Real accepted friends only
        const { data: fs } = await supabase
          .from('friendships')
          .select('requester_id, addressee_id')
          .eq('status', 'accepted')
          .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);

        const friendIds = Array.from(
          new Set(
            (fs ?? [])
              .map(r => (r.requester_id === user.id ? r.addressee_id : r.requester_id))
              .filter(Boolean),
          ),
        );

        if (friendIds.length === 0) {
          setFriends([]);
          return;
        }

        const { data: profs } = await supabase
          .from('profiles')
          .select('user_id, name, avatar_url')
          .in('user_id', friendIds);

        setFriends(((profs as FriendRow[]) ?? []).sort((a, b) =>
          (a.name ?? '').localeCompare(b.name ?? ''),
        ));
      } finally {
        setLoading(false);
      }
    })();
  }, [open, user]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return friends;
    return friends.filter(f => (f.name ?? '').toLowerCase().includes(q));
  }, [friends, search]);

  const selectedFriends = useMemo(
    () => friends.filter(f => selected.has(f.user_id)),
    [friends, selected],
  );

  const toggle = (uid: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else if (next.size < MAX_INVITEES) next.add(uid);
      else toast.error(`Maximum ${MAX_INVITEES} invités`);
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

  // Draggable on desktop, fullscreen on mobile
  const isMobile = useIsMobile();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    if (isMobile) {
      setPos(null);
      return;
    }
    // Center on first open
    setPos((prev) => {
      if (prev) return prev;
      const w = 420;
      const h = Math.min(window.innerHeight * 0.8, 640);
      return {
        x: Math.max(16, (window.innerWidth - w) / 2),
        y: Math.max(16, (window.innerHeight - h) / 2),
      };
    });
  }, [open, isMobile]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (isMobile || !pos) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const w = 420;
    const h = 640;
    const x = Math.min(Math.max(0, e.clientX - dragRef.current.dx), window.innerWidth - 100);
    const y = Math.min(Math.max(0, e.clientY - dragRef.current.dy), window.innerHeight - 80);
    setPos({ x, y });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
  };

  if (!open) return null;

  const panel = (
    <div
      className={
        isMobile
          ? 'fixed inset-0 z-[120] bg-background flex flex-col'
          : 'fixed z-[120] w-[420px] max-h-[80vh] rounded-2xl border bg-background shadow-2xl flex flex-col overflow-hidden'
      }
      style={isMobile || !pos ? undefined : { left: pos.x, top: pos.y }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={`flex items-center justify-between px-5 py-3 border-b ${
          isMobile ? '' : 'cursor-grab active:cursor-grabbing select-none'
        }`}
      >
        <div className="flex items-center gap-2 text-base font-semibold">
          <Users className="w-5 h-5 text-primary" />
          Appel de groupe
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-full hover:bg-muted transition"
          aria-label="Fermer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-5 pt-4 pb-3 space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Rechercher un ami…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 rounded-full"
          />
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {selected.size} / {MAX_INVITEES} sélectionné{selected.size > 1 ? 's' : ''}
          </span>
          {selected.size > 0 && (
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Tout effacer
            </button>
          )}
        </div>

        {selectedFriends.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {selectedFriends.map(f => (
              <Badge
                key={f.user_id}
                variant="secondary"
                className="pl-1 pr-2 py-1 gap-1.5 rounded-full cursor-pointer"
                onClick={() => toggle(f.user_id)}
              >
                <UserAvatar src={f.avatar_url} alt={f.name ?? ''} size="xs" />
                <span className="text-xs">{f.name ?? '—'}</span>
                <X className="w-3 h-3 opacity-60" />
              </Badge>
            ))}
          </div>
        )}
      </div>

      <ScrollArea className="flex-1 min-h-0 px-2">
        <div className="px-3 pb-2 space-y-0.5">
          {loading && (
            <p className="text-center text-sm text-muted-foreground py-8">Chargement…</p>
          )}
          {!loading && friends.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-8">
              Aucun ami pour l'instant
            </p>
          )}
          {!loading && friends.length > 0 && filtered.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-8">
              Aucun résultat
            </p>
          )}
          {filtered.map(f => {
            const isOn = selected.has(f.user_id);
            return (
              <button
                key={f.user_id}
                onClick={() => toggle(f.user_id)}
                className={`w-full flex items-center gap-3 p-2 rounded-xl transition ${
                  isOn ? 'bg-primary/10' : 'hover:bg-muted/60'
                }`}
              >
                <Checkbox checked={isOn} onCheckedChange={() => toggle(f.user_id)} />
                <UserAvatar src={f.avatar_url} alt={f.name ?? ''} size="sm" />
                <div className="flex-1 text-left min-w-0">
                  <p className="text-sm font-medium truncate">{f.name ?? 'Sans nom'}</p>
                </div>
              </button>
            );
          })}
        </div>
      </ScrollArea>

      <div
        className="px-5 py-4 border-t bg-background flex gap-3"
        style={isMobile ? { paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' } : undefined}
      >
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
    </div>
  );

  return createPortal(panel, document.body);
}
