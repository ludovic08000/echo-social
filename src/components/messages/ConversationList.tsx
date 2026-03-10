import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Send, Search, Plus, Sparkles, Trash2 } from 'lucide-react';
import { AppLayout } from '@/components/AppLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConversations, useDeleteConversation } from '@/hooks/useMessages';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { NewConversationDialog } from './NewConversationDialog';
import { formatMessageTime } from './constants';

export function ConversationList() {
  const { data: conversations, isLoading } = useConversations();
  const [search, setSearch] = useState('');
  const [showNewChat, setShowNewChat] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const deleteConversation = useDeleteConversation();

  const filtered = useMemo(() => {
    if (!search.trim() || !conversations) return conversations;
    const q = search.toLowerCase();
    return conversations.filter(c => c.participant.name.toLowerCase().includes(q));
  }, [conversations, search]);

  const handleDelete = async (convId: string) => {
    try {
      await deleteConversation.mutateAsync(convId);
    } catch {
      toast.error('Erreur lors de la suppression');
    }
    setDeleteTarget(null);
  };

  return (
    <AppLayout>
      <div className="px-4 py-2">
        {/* Header */}
        <header className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Messages</h1>
            <p className="text-[11px] text-muted-foreground">Chiffré de bout en bout 🔒</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full bg-primary/10 text-primary hover:bg-primary/20"
              onClick={() => setShowNewChat(true)}
            >
              <Plus className="w-5 h-5" />
            </Button>
          </div>
        </header>

        {/* Search */}
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Rechercher une conversation…"
            className="w-full bg-secondary/60 rounded-xl pl-9 pr-4 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus:bg-secondary transition-colors"
          />
        </div>

        {/* Online friends strip */}
        {!search && conversations && conversations.length > 0 && (
          <div className="flex gap-3 mb-4 overflow-x-auto scrollbar-none pb-1">
            {conversations.slice(0, 8).map(conv => (
              <Link
                key={conv.id}
                to={`/messages/${conv.id}`}
                className="flex flex-col items-center gap-1 min-w-[56px] group"
              >
                <div className="relative">
                  <UserAvatar src={conv.participant.avatar_url} alt={conv.participant.name} size="md" />
                  <div className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-emerald-500 border-2 border-background" />
                </div>
                <span className="text-[10px] text-muted-foreground truncate max-w-[56px] group-hover:text-foreground transition-colors">
                  {conv.participant.name.split(' ')[0]}
                </span>
              </Link>
            ))}
          </div>
        )}

        {/* List */}
        <div className="space-y-0.5">
          {isLoading ? (
            <div className="space-y-1">
              {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className="flex gap-3 p-3 animate-pulse rounded-2xl">
                  <div className="w-13 h-13 rounded-full bg-muted flex-shrink-0" style={{ width: 52, height: 52 }} />
                  <div className="flex-1 space-y-2 py-1">
                    <div className="h-3.5 w-28 bg-muted rounded-lg" />
                    <div className="h-3 w-44 bg-muted rounded-lg" />
                  </div>
                </div>
              ))}
            </div>
          ) : !filtered?.length ? (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <div className="relative">
                <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-primary/20 to-accent/30 flex items-center justify-center">
                  <Send className="w-8 h-8 text-primary" />
                </div>
                <Sparkles className="w-5 h-5 text-primary absolute -top-1 -right-1 animate-pulse" />
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold text-foreground">
                  {search ? 'Aucun résultat' : 'Aucune conversation'}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {search ? 'Essayez un autre terme' : 'Commencez à discuter avec vos amis !'}
                </p>
              </div>
              {!search && (
                <Button
                  className="rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/20"
                  size="sm"
                  onClick={() => setShowNewChat(true)}
                >
                  <Plus className="w-4 h-4 mr-1.5" />
                  Nouvelle conversation
                </Button>
              )}
            </div>
          ) : (
            filtered.map(conv => (
              <div key={conv.id} className="relative group">
                <Link
                  to={`/messages/${conv.id}`}
                  className={cn(
                    "flex items-center gap-3 p-3 rounded-2xl transition-all duration-200 active:scale-[0.98]",
                    conv.unread_count > 0
                      ? "bg-primary/5 hover:bg-primary/10 border border-primary/10"
                      : "hover:bg-secondary/60"
                  )}
                >
                  <div className="relative flex-shrink-0">
                    {conv.is_group ? (
                      <div className="w-[52px] h-[52px] rounded-full bg-gradient-to-br from-primary/20 to-accent/30 flex items-center justify-center text-lg">
                        👥
                      </div>
                    ) : (
                      <>
                        <UserAvatar src={conv.participant.avatar_url} alt={conv.participant.name} size="lg" />
                        <div className="absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full bg-emerald-500 border-[2.5px] border-background" />
                      </>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn(
                        "text-sm truncate",
                        conv.unread_count > 0 ? "font-bold text-foreground" : "font-medium"
                      )}>
                        {conv.is_group ? (conv.name || 'Groupe') : conv.participant.name}
                      </span>
                      {conv.last_message && (
                        <span className={cn(
                          "text-[10px] flex-shrink-0",
                          conv.unread_count > 0 ? "text-primary font-semibold" : "text-muted-foreground"
                        )}>
                          {formatMessageTime(conv.last_message.created_at)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <p className={cn(
                        "text-xs truncate flex-1",
                        conv.unread_count > 0 ? "text-foreground font-medium" : "text-muted-foreground"
                      )}>
                        {conv.last_message?.body
                          ? conv.last_message.body.startsWith('📞 CALL:missed|')
                            ? `📞 Appel ${conv.last_message.body.includes('video') ? 'vidéo' : 'audio'} manqué`
                            : conv.last_message.body.startsWith('📞 CALL:ended|')
                              ? `📞 Appel ${conv.last_message.body.includes('video') ? 'vidéo' : 'audio'} terminé`
                              : conv.last_message.body
                          : 'Démarrez la conversation…'}
                      </p>
                      {conv.unread_count > 0 && (
                        <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center flex-shrink-0 shadow-sm shadow-primary/30">
                          {conv.unread_count > 9 ? '9+' : conv.unread_count}
                        </span>
                      )}
                    </div>
                  </div>
                </Link>
                {/* Delete button on hover/touch */}
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDeleteTarget(conv.id); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity h-8 w-8 rounded-full bg-destructive/10 hover:bg-destructive/20 flex items-center justify-center"
                >
                  <Trash2 className="w-3.5 h-3.5 text-destructive" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <NewConversationDialog open={showNewChat} onOpenChange={setShowNewChat} />

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-base">Supprimer cette conversation ?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            La conversation sera supprimée de votre liste. Les messages resteront visibles pour les autres participants.
          </p>
          <div className="flex gap-2 mt-2">
            <Button variant="outline" className="flex-1 rounded-xl" onClick={() => setDeleteTarget(null)}>
              Annuler
            </Button>
            <Button
              variant="destructive"
              className="flex-1 rounded-xl"
              disabled={deleteConversation.isPending}
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
            >
              {deleteConversation.isPending ? 'Suppression…' : 'Supprimer'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
