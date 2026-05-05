import { useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Send, Search, Plus, Edit, Trash2, Sparkles, Lock } from 'lucide-react';
import { AppLayout } from '@/components/AppLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConversations, useDeleteConversation } from '@/hooks/useMessages';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { NewConversationDialog } from './NewConversationDialog';
import { formatMessageTime } from './constants';
import { ConversationPreviewText } from './ConversationPreviewText';

export function ConversationList() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: conversations, isLoading } = useConversations();
  const [search, setSearch] = useState('');
  const [showNewChat, setShowNewChat] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const deleteConversation = useDeleteConversation();

  const { data: recoveryState } = useQuery({
    queryKey: ['messaging-recovery-state', user?.id ?? 'anon'],
    enabled: !!user,
    refetchOnMount: 'always',
    refetchOnReconnect: 'always',
    queryFn: async () => {
      if (!user) return null;

      const [{ hasWrappedKeys }, { hasRawIdentityKeys }] = await Promise.all([
        import('@/lib/crypto/pinWrap'),
        import('@/lib/crypto/keyManager'),
      ]);

      const [wrappedKeysPresent, rawIdentityPresent, backupCountResult, conversationCountResult] = await Promise.all([
        hasWrappedKeys(user.id),
        hasRawIdentityKeys(user.id),
        supabase.from('user_backups' as any).select('id', { count: 'exact', head: true }).eq('user_id', user.id),
        supabase.from('conversation_participants').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
      ]);

      const totalConversations = conversationCountResult.count ?? 0;
      const hasServerBackup = (backupCountResult.count ?? 0) > 0;
      const needsPinUnlock = !rawIdentityPresent && wrappedKeysPresent;
      const needsExplicitRestore = !rawIdentityPresent && !wrappedKeysPresent && hasServerBackup;

      console.log('[messaging] conversation recovery state', {
        userId: user.id,
        totalConversations,
        rawIdentityPresent,
        wrappedKeysPresent,
        hasServerBackup,
        needsPinUnlock,
        needsExplicitRestore,
      });

      return {
        totalConversations,
        rawIdentityPresent,
        wrappedKeysPresent,
        hasServerBackup,
        needsPinUnlock,
        needsExplicitRestore,
      };
    },
  });

  const filtered = useMemo(() => {
    if (!search.trim() || !conversations) return conversations;
    const q = search.toLowerCase();
    return conversations.filter(c => c.participant.name.toLowerCase().includes(q));
  }, [conversations, search]);

  const shouldShowSecureEmptyState =
    !search &&
    (recoveryState?.totalConversations ?? 0) > 0 &&
    (recoveryState?.needsPinUnlock || recoveryState?.needsExplicitRestore);

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
      <div className="max-w-2xl mx-auto">
        <header className="sticky top-0 z-30 bg-background/95 backdrop-blur-sm px-4 pt-4 pb-3">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-2xl font-extrabold tracking-tight">Discussions</h1>
            <div className="flex items-center gap-2">
              <Button
                size="icon"
                variant="ghost"
                className="h-9 w-9 rounded-full text-primary hover:bg-primary/10"
                onClick={() => window.dispatchEvent(new CustomEvent('open-zeus', { detail: { action: 'message-help' } }))}
                title="Zeus IA"
              >
                <Sparkles className="w-4 h-4" />
              </Button>
              <Button
                size="icon"
                variant="secondary"
                className="h-9 w-9 rounded-full"
                onClick={() => setShowNewChat(true)}
              >
                <Edit className="w-4 h-4" />
              </Button>
            </div>
          </div>

          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Rechercher dans Messenger"
              className="w-full bg-secondary rounded-full pl-10 pr-4 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/20 transition-all"
            />
          </div>
        </header>

        {/* Silent recovery: no "Restaurer mes clés" CTA in the conversation
            list. Restoration runs automatically in background (useAccountKeySync
            + realtimeKeySync + messageQueue). The dedicated UI is in
            Settings → Privacy → Key Backup. */}

        {!search && conversations && conversations.length > 0 && (
          <div className="flex gap-4 px-4 py-3 overflow-x-auto scrollbar-none">
            {conversations.slice(0, 10).map(conv => (
              <Link
                key={conv.id}
                to={`/messages/${conv.id}`}
                className="flex flex-col items-center gap-1.5 min-w-[60px]"
              >
                <div className="relative">
                  <UserAvatar src={conv.participant.avatar_url} alt={conv.participant.name} size="md" />
                  <div className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-emerald-500 border-2 border-background" />
                </div>
                <span className="text-[11px] text-muted-foreground truncate max-w-[60px] leading-tight text-center">
                  {conv.participant.name.split(' ')[0]}
                </span>
              </Link>
            ))}
          </div>
        )}

        <div className="px-2">
          {isLoading ? (
            <div className="space-y-1 px-2">
              {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className="flex gap-3 p-3 animate-pulse rounded-xl">
                  <div className="w-14 h-14 rounded-full bg-muted flex-shrink-0" />
                  <div className="flex-1 space-y-2 py-2">
                    <div className="h-3.5 w-28 bg-muted rounded" />
                    <div className="h-3 w-44 bg-muted rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : !filtered?.length ? (
              <div className="flex flex-col items-center justify-center py-20 gap-4">
                <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center">
                  <Send className="w-7 h-7 text-muted-foreground" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-semibold">
                    {search ? 'Aucun résultat' : 'Aucune conversation'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {search ? 'Essayez un autre terme' : 'Commencez à discuter avec vos amis'}
                  </p>
                </div>
                {!search && (
                  <Button
                    className="rounded-full"
                    size="sm"
                    onClick={() => setShowNewChat(true)}
                  >
                    <Plus className="w-4 h-4 mr-1.5" />
                    Nouvelle conversation
                  </Button>
                )}
              </div>
            )
          ) : (
            filtered.map(conv => (
              <div key={conv.id} className="relative group">
                <Link
                  to={`/messages/${conv.id}`}
                  className={cn(
                    'flex items-center gap-3 px-3 py-3 rounded-2xl transition-all duration-200',
                    conv.unread_count > 0
                      ? 'bg-primary/5 hover:bg-primary/8'
                      : 'hover:bg-secondary/50'
                  )}
                >
                  <div className="relative flex-shrink-0">
                    {conv.is_group ? (
                      <div className="w-14 h-14 rounded-full bg-gradient-to-br from-primary/20 to-accent/30 flex items-center justify-center text-xl">
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
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={cn(
                        'text-[15px] truncate',
                        conv.unread_count > 0 ? 'font-bold' : 'font-medium'
                      )}>
                        {conv.is_group ? (conv.name || 'Groupe') : conv.participant.name}
                      </span>
                      {conv.last_message && (
                        <span className={cn(
                          'text-xs flex-shrink-0',
                          conv.unread_count > 0 ? 'text-foreground font-semibold' : 'text-muted-foreground'
                        )}>
                          {formatMessageTime(conv.last_message.created_at)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <p className={cn(
                        'text-[13px] truncate flex-1',
                        conv.unread_count > 0 ? 'text-foreground font-medium' : 'text-muted-foreground'
                      )}>
                        <ConversationPreviewText body={conv.last_message?.body} />
                      </p>
                      {conv.unread_count > 0 && (
                        <div className="min-w-[20px] h-5 rounded-full bg-primary flex items-center justify-center flex-shrink-0 px-1.5">
                          <span className="text-[11px] font-bold text-primary-foreground leading-none">
                            {conv.unread_count > 99 ? '99+' : conv.unread_count}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </Link>

                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDeleteTarget(conv.id); }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity h-8 w-8 rounded-full bg-secondary hover:bg-destructive/10 flex items-center justify-center"
                >
                  <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <NewConversationDialog open={showNewChat} onOpenChange={setShowNewChat} />

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
