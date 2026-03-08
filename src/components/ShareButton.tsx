import { useState, useMemo } from 'react';
import { Share2, Copy, Check, Send, FileText, Radio, MessageCircle, Users, X, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { shareUrl, ShareData } from '@/lib/urlUtils';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { useConversations, useCreateConversation, useSendMessage } from '@/hooks/useMessages';
import { UserAvatar } from './UserAvatar';
import { useChatWidget } from './ChatWidgetContext';

interface ShareButtonProps {
  url: string;
  title?: string;
  text?: string;
  variant?: 'default' | 'ghost' | 'outline' | 'secondary';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  className?: string;
  showLabel?: boolean;
}

export function ShareButton({
  url,
  title,
  text,
  variant = 'ghost',
  size = 'icon',
  className,
  showLabel = false,
}: ShareButtonProps) {
  const [showShareDialog, setShowShareDialog] = useState(false);

  return (
    <>
      <Button
        variant={variant}
        size={size}
        onClick={() => setShowShareDialog(true)}
        className={cn('gap-2', className)}
      >
        <Share2 className="w-4 h-4" />
        {showLabel && <span>Partager</span>}
      </Button>

      <ShareDialog
        open={showShareDialog}
        onOpenChange={setShowShareDialog}
        url={url}
        title={title}
        text={text}
      />
    </>
  );
}

// ─── Share Dialog ────────────────────────────────────────
function ShareDialog({
  open,
  onOpenChange,
  url,
  title,
  text,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  url: string;
  title?: string;
  text?: string;
}) {
  const { user } = useAuth();
  const { openConversation } = useChatWidget();
  const [search, setSearch] = useState('');
  const [sending, setSending] = useState<string | null>(null);
  const { data: conversations } = useConversations();
  const sendMessage = useSendMessage();

  const shareText = text || title || url;
  const fullShareText = `${shareText}\n${url}`;

  const filteredConversations = useMemo(() => {
    if (!conversations) return [];
    if (!search.trim()) return conversations.slice(0, 8);
    const q = search.toLowerCase();
    return conversations.filter(c =>
      c.participant.name.toLowerCase().includes(q) ||
      (c.name && c.name.toLowerCase().includes(q))
    );
  }, [conversations, search]);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: 'Lien copié !', description: 'Le lien a été copié dans votre presse-papiers' });
      onOpenChange(false);
    } catch {
      toast({ title: 'Erreur', description: 'Impossible de copier le lien', variant: 'destructive' });
    }
  };

  const shareToFeed = async () => {
    if (!user) return;
    try {
      await supabase.from('posts').insert({
        user_id: user.id,
        body: `🔗 ${shareText}\n\n${url}`,
      });
      toast({ title: 'Partagé !', description: 'Publié sur votre fil d\'actualité' });
      onOpenChange(false);
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const shareToConversation = async (conversationId: string) => {
    setSending(conversationId);
    try {
      await sendMessage.mutateAsync({ conversationId, body: `🔗 ${fullShareText}` });
      toast({ title: 'Envoyé !', description: 'Contenu partagé dans la conversation' });
      onOpenChange(false);
      // Open the messenger on that conversation
      openConversation(conversationId);
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    } finally {
      setSending(null);
    }
  };

  const shareExternal = (platform: string) => {
    const encoded = encodeURIComponent(url);
    const encodedText = encodeURIComponent(shareText);
    const urls: Record<string, string> = {
      x: `https://twitter.com/intent/tweet?url=${encoded}&text=${encodedText}`,
      facebook: `https://www.facebook.com/sharer/sharer.php?u=${encoded}`,
      whatsapp: `https://wa.me/?text=${encodeURIComponent(shareText + ' ' + url)}`,
    };
    window.open(urls[platform], '_blank');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] flex flex-col p-0 gap-0 rounded-2xl overflow-hidden">
        <DialogHeader className="p-4 pb-2">
          <DialogTitle className="text-base font-bold">Partager</DialogTitle>
        </DialogHeader>

        {/* Preview */}
        <div className="mx-4 mb-3 p-3 rounded-xl bg-secondary/50 border border-border/30">
          <p className="text-xs text-muted-foreground truncate">{shareText}</p>
          <p className="text-[10px] text-primary truncate mt-0.5">{url}</p>
        </div>

        {/* Quick actions */}
        <div className="px-4 pb-3">
          <div className="grid grid-cols-4 gap-2">
            <button
              onClick={shareToFeed}
              className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-secondary/50 hover:bg-secondary transition-all active:scale-95"
            >
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                <FileText className="w-5 h-5 text-primary" />
              </div>
              <span className="text-[10px] font-medium">Mon fil</span>
            </button>
            <button
              onClick={copyToClipboard}
              className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-secondary/50 hover:bg-secondary transition-all active:scale-95"
            >
              <div className="w-10 h-10 rounded-full bg-accent/10 flex items-center justify-center">
                <Copy className="w-5 h-5 text-accent-foreground" />
              </div>
              <span className="text-[10px] font-medium">Copier</span>
            </button>
            <button
              onClick={() => shareExternal('whatsapp')}
              className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-secondary/50 hover:bg-secondary transition-all active:scale-95"
            >
              <div className="w-10 h-10 rounded-full bg-emerald-500/10 flex items-center justify-center">
                <span className="text-lg">W</span>
              </div>
              <span className="text-[10px] font-medium">WhatsApp</span>
            </button>
            <button
              onClick={() => {
                if (navigator.share) {
                  navigator.share({ url, title, text }).catch(() => {});
                  onOpenChange(false);
                } else {
                  shareExternal('x');
                }
              }}
              className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-secondary/50 hover:bg-secondary transition-all active:scale-95"
            >
              <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center">
                <Share2 className="w-5 h-5 text-foreground" />
              </div>
              <span className="text-[10px] font-medium">Plus…</span>
            </button>
          </div>
        </div>

        {/* Send to friend */}
        {user && (
          <>
            <div className="px-4 pb-2">
              <p className="text-xs font-semibold text-muted-foreground mb-2">Envoyer à un ami</p>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Rechercher…"
                  className="w-full bg-secondary/60 rounded-xl pl-9 pr-4 py-2 text-xs outline-none placeholder:text-muted-foreground focus:bg-secondary transition-colors"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-1 max-h-[200px]">
              {!filteredConversations.length ? (
                <p className="text-xs text-muted-foreground text-center py-4">
                  {search ? 'Aucun résultat' : 'Aucune conversation'}
                </p>
              ) : (
                filteredConversations.map(conv => (
                  <button
                    key={conv.id}
                    onClick={() => shareToConversation(conv.id)}
                    disabled={sending === conv.id}
                    className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-secondary/60 transition-all active:scale-[0.98]"
                  >
                    <div className="relative flex-shrink-0">
                      {conv.is_group ? (
                        <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-sm">
                          👥
                        </div>
                      ) : (
                        <UserAvatar src={conv.participant.avatar_url} alt={conv.participant.name} size="sm" />
                      )}
                    </div>
                    <span className="text-xs font-medium truncate flex-1 text-left">
                      {conv.is_group ? (conv.name || 'Groupe') : conv.participant.name}
                    </span>
                    {sending === conv.id ? (
                      <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin flex-shrink-0" />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <Send className="w-3.5 h-3.5 text-primary" />
                      </div>
                    )}
                  </button>
                ))
              )}
            </div>
          </>
        )}

        {/* External sharing */}
        <div className="border-t border-border/30 px-4 py-3 flex items-center gap-2">
          <button
            onClick={() => shareExternal('x')}
            className="flex-1 flex items-center justify-center gap-2 py-2 rounded-xl bg-secondary/50 hover:bg-secondary transition-all text-xs font-medium"
          >
            <span className="text-sm">𝕏</span> X
          </button>
          <button
            onClick={() => shareExternal('facebook')}
            className="flex-1 flex items-center justify-center gap-2 py-2 rounded-xl bg-secondary/50 hover:bg-secondary transition-all text-xs font-medium"
          >
            <span className="text-sm">f</span> Facebook
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
