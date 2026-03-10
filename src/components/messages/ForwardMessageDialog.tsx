import { useState, useMemo } from 'react';
import { Search, Forward } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { UserAvatar } from '@/components/UserAvatar';
import { useConversations } from '@/hooks/useMessages';

interface ForwardMessageDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  messageBody: string;
  onForward: (conversationId: string) => void;
}

export function ForwardMessageDialog({ open, onOpenChange, messageBody, onForward }: ForwardMessageDialogProps) {
  const { data: conversations } = useConversations();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!conversations) return [];
    if (!search.trim()) return conversations;
    const q = search.toLowerCase();
    return conversations.filter(c =>
      c.participant.name.toLowerCase().includes(q) ||
      (c.name && c.name.toLowerCase().includes(q))
    );
  }, [conversations, search]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[70vh] flex flex-col p-0 gap-0 rounded-2xl">
        <DialogHeader className="p-4 pb-0">
          <DialogTitle className="text-base font-bold">Transférer le message</DialogTitle>
        </DialogHeader>
        <div className="px-4 pt-3 pb-1">
          <div className="glass rounded-xl px-3 py-2 mb-2 border border-border/20">
            <p className="text-xs text-muted-foreground line-clamp-2">{messageBody}</p>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Rechercher…"
              className="w-full bg-secondary/60 rounded-xl pl-9 pr-4 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus:bg-secondary transition-colors"
              autoFocus
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {!filtered.length ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Aucune conversation</div>
          ) : (
            filtered.map(conv => (
              <button
                key={conv.id}
                onClick={() => { onForward(conv.id); onOpenChange(false); }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-secondary/60 active:scale-[0.98] transition-all"
              >
                {conv.is_group ? (
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary/20 to-accent/30 flex items-center justify-center text-lg flex-shrink-0">👥</div>
                ) : (
                  <UserAvatar src={conv.participant.avatar_url} alt={conv.participant.name} size="md" />
                )}
                <span className="text-sm font-medium truncate flex-1 text-left">
                  {conv.is_group ? (conv.name || 'Groupe') : conv.participant.name}
                </span>
                <Forward className="w-4 h-4 text-primary flex-shrink-0" />
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
