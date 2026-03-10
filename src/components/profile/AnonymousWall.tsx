import { useState } from 'react';
import { Send, Check, X, Trash2, MessageSquare, Ghost } from 'lucide-react';
import { useAnonymousWall, usePostWallMessage, useApproveWallMessage, useDeleteWallMessage } from '@/hooks/useAnonymousWall';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

interface AnonymousWallProps {
  targetUserId: string;
  isOwnProfile: boolean;
}

export function AnonymousWall({ targetUserId, isOwnProfile }: AnonymousWallProps) {
  const { user } = useAuth();
  const { data: messages, isLoading } = useAnonymousWall(targetUserId);
  const postMessage = usePostWallMessage();
  const approveMessage = useApproveWallMessage();
  const deleteMessage = useDeleteWallMessage();
  const [newMessage, setNewMessage] = useState('');

  const visibleMessages = isOwnProfile
    ? messages
    : messages?.filter(m => m.is_approved);

  const pendingCount = isOwnProfile
    ? messages?.filter(m => !m.is_approved).length || 0
    : 0;

  const handlePost = async () => {
    if (!newMessage.trim() || !user) return;
    try {
      await postMessage.mutateAsync({ targetUserId, message: newMessage.trim() });
      setNewMessage('');
      toast({ title: '👻 Message envoyé !', description: 'Il sera visible après modération.' });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const handleApprove = async (id: string, approved: boolean) => {
    try {
      await approveMessage.mutateAsync({ id, approved });
      toast({ title: approved ? 'Message approuvé ✓' : 'Message rejeté' });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteMessage.mutateAsync(id);
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  return (
    <div className="premium-card p-4">
      <div className="flex items-center gap-2 mb-4">
        <Ghost className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold">Mur anonyme</h3>
        {pendingCount > 0 && (
          <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-semibold">
            {pendingCount} en attente
          </span>
        )}
      </div>

      {/* Post form (only for non-own profiles) */}
      {!isOwnProfile && user && user.id !== targetUserId && (
        <div className="mb-4">
          <Textarea
            value={newMessage}
            onChange={e => setNewMessage(e.target.value)}
            placeholder="Écrivez un message anonyme…"
            className="rounded-xl text-sm min-h-[60px] resize-none mb-2"
            maxLength={500}
          />
          <Button
            size="sm"
            onClick={handlePost}
            disabled={!newMessage.trim() || postMessage.isPending}
            className="premium-button h-8 text-xs"
          >
            <Send className="w-3.5 h-3.5 mr-1" />
            {postMessage.isPending ? 'Envoi…' : 'Envoyer'}
          </Button>
        </div>
      )}

      {/* Messages */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2].map(i => (
            <div key={i} className="p-3 rounded-xl bg-secondary/40 animate-pulse">
              <div className="h-3 w-3/4 bg-muted rounded" />
            </div>
          ))}
        </div>
      ) : !visibleMessages?.length ? (
        <p className="text-xs text-muted-foreground/60 text-center py-4">
          <MessageSquare className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
          Aucun message pour le moment
        </p>
      ) : (
        <div className="space-y-2">
          {visibleMessages.map(msg => (
            <div
              key={msg.id}
              className={cn(
                "p-3 rounded-xl text-sm",
                msg.is_approved
                  ? "bg-secondary/40"
                  : "bg-amber-500/10 border border-amber-500/20"
              )}
            >
              <p className="text-sm">{msg.message}</p>
              <div className="flex items-center justify-between mt-2">
                <span className="text-[10px] text-muted-foreground/60">
                  {new Date(msg.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
                {isOwnProfile && (
                  <div className="flex gap-1">
                    {!msg.is_approved && (
                      <>
                        <Button variant="ghost" size="icon" className="h-6 w-6 text-primary" onClick={() => handleApprove(msg.id, true)}>
                          <Check className="w-3.5 h-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" onClick={() => handleApprove(msg.id, false)}>
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </>
                    )}
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => handleDelete(msg.id)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
