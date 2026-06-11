import { useState, useMemo, useEffect } from 'react';
import { Search, Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/UserAvatar';
import { useFriendships } from '@/hooks/useFriendships';
import { useCreateConversation, useCreateGroupConversation } from '@/hooks/useMessages';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface NewConversationDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

interface UserResult {
  id: string;
  user_id: string;
  name: string;
  avatar_url: string | null;
  isFriend?: boolean;
}

export function NewConversationDialog({ open, onOpenChange }: NewConversationDialogProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'single' | 'group'>('single');
  const [groupName, setGroupName] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [searchResults, setSearchResults] = useState<UserResult[]>([]);
  const [searching, setSearching] = useState(false);
  const { data: friendsData, isLoading } = useFriendships();
  const createConversation = useCreateConversation();
  const createGroup = useCreateGroupConversation();

  const friends = friendsData?.friends || [];
  const friendsAsResults: UserResult[] = useMemo(
    () => friends.map(f => ({
      id: f.id,
      user_id: f.profile.user_id,
      name: f.profile.name,
      avatar_url: f.profile.avatar_url,
      isFriend: true,
    })),
    [friends]
  );

  // Global search across all users (not just friends)
  useEffect(() => {
    const q = search.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .ilike('name', `%${q}%`)
        .neq('user_id', user?.id || '')
        .limit(30);
      if (cancelled) return;
      setSearching(false);
      if (error) {
        console.error('User search failed:', error);
        return;
      }
      const friendIds = new Set(friends.map(f => f.profile.user_id));
      setSearchResults(
        (data || []).map(p => ({
          id: p.user_id,
          user_id: p.user_id,
          name: p.name || 'Utilisateur',
          avatar_url: p.avatar_url,
          isFriend: friendIds.has(p.user_id),
        }))
      );
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [search, user?.id, friends]);

  const displayed: UserResult[] = useMemo(() => {
    if (search.trim()) {
      // Merge friends matching the query first, then non-friend results
      const q = search.toLowerCase();
      const matchingFriends = friendsAsResults.filter(f => f.name.toLowerCase().includes(q));
      const friendIds = new Set(matchingFriends.map(f => f.user_id));
      const others = searchResults.filter(r => !friendIds.has(r.user_id));
      return [...matchingFriends, ...others];
    }
    return friendsAsResults;
  }, [search, friendsAsResults, searchResults]);

  const handleSelect = async (userId: string) => {
    if (mode === 'group') {
      setSelectedMembers(prev =>
        prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId]
      );
      return;
    }
    try {
      const conv = await createConversation.mutateAsync(userId);
      onOpenChange(false);
      navigate(`/messages/${conv.id}`);
    } catch (e: any) {
      console.error('Failed to create conversation:', e);
      toast.error(e?.message || 'Impossible de créer la conversation');
    }
  };

  const handleCreateGroup = async () => {
    if (!groupName.trim() || selectedMembers.length < 2) return;
    try {
      const conv = await createGroup.mutateAsync({ name: groupName.trim(), memberIds: selectedMembers });
      onOpenChange(false);
      setMode('single');
      setGroupName('');
      setSelectedMembers([]);
      navigate(`/messages/${conv.id}`);
    } catch (e: any) {
      toast.error(e.message || 'Erreur');
    }
  };

  const handleClose = (v: boolean) => {
    if (!v) {
      setMode('single');
      setGroupName('');
      setSelectedMembers([]);
      setSearch('');
      setSearchResults([]);
    }
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md max-h-[80vh] flex flex-col p-0 gap-0 rounded-2xl">
        <DialogHeader className="p-4 pb-0">
          <DialogTitle className="text-base font-bold">
            {mode === 'group' ? 'Créer un groupe' : 'Nouvelle conversation'}
          </DialogTitle>
        </DialogHeader>

        {/* Mode toggle */}
        <div className="flex gap-2 px-4 pt-3">
          <button
            onClick={() => { setMode('single'); setSelectedMembers([]); }}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
              mode === 'single' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
            )}
          >
            1 à 1
          </button>
          <button
            onClick={() => setMode('group')}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
              mode === 'group' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
            )}
          >
            👥 Groupe
          </button>
        </div>

        {/* Group name */}
        {mode === 'group' && (
          <div className="px-4 pt-3">
            <input
              value={groupName}
              onChange={e => setGroupName(e.target.value)}
              placeholder="Nom du groupe…"
              className="w-full bg-secondary/60 rounded-xl px-4 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus:bg-secondary transition-colors"
            />
            {selectedMembers.length > 0 && (
              <p className="text-[10px] text-muted-foreground mt-1.5">
                {selectedMembers.length} membre{selectedMembers.length > 1 ? 's' : ''} sélectionné{selectedMembers.length > 1 ? 's' : ''}
              </p>
            )}
          </div>
        )}

        <div className="px-4 pt-3 pb-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Rechercher n'importe qui…"
              className="w-full bg-secondary/60 rounded-xl pl-9 pr-4 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus:bg-secondary transition-colors"
              autoFocus
            />
          </div>
          {!search && (
            <p className="text-[10px] text-muted-foreground mt-2 px-1">
              Vos amis sont affichés ci-dessous. Tapez un nom pour trouver n'importe quel utilisateur.
            </p>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {(isLoading && !search) || (searching && search) ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Chargement…</div>
          ) : displayed.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-muted-foreground">
                {search ? 'Aucun utilisateur trouvé' : 'Tapez un nom pour rechercher'}
              </p>
            </div>
          ) : (
            displayed.map(u => {
              const isSelected = selectedMembers.includes(u.user_id);
              return (
                <button
                  key={u.user_id}
                  onClick={() => handleSelect(u.user_id)}
                  disabled={createConversation.isPending || createGroup.isPending}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-secondary/60 active:scale-[0.98] transition-all duration-200",
                    mode === 'group' && isSelected && "bg-primary/10 ring-1 ring-primary/30"
                  )}
                >
                  <UserAvatar src={u.avatar_url} alt={u.name} size="md" />
                  <div className="flex-1 min-w-0 text-left">
                    <div className="text-sm font-medium truncate">{u.name}</div>
                    {!u.isFriend && (
                      <div className="text-[10px] text-muted-foreground">Pas encore ami</div>
                    )}
                  </div>
                  {mode === 'group' && (
                    <div className={cn(
                      "w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors",
                      isSelected ? "bg-primary border-primary" : "border-muted-foreground/30"
                    )}>
                      {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Create group button */}
        {mode === 'group' && (
          <div className="px-4 pb-4">
            <Button
              className="w-full rounded-xl"
              disabled={!groupName.trim() || selectedMembers.length < 2 || createGroup.isPending}
              onClick={handleCreateGroup}
            >
              {createGroup.isPending ? (
                <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
              ) : (
                <>👥 Créer le groupe ({selectedMembers.length} membres)</>
              )}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
