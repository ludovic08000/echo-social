import { useState, useRef, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Send, Phone, Video, MoreVertical } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { AppLayout } from '@/components/AppLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { useConversations, useMessages, useSendMessage, useMarkConversationRead } from '@/hooks/useMessages';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

export default function Messages() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const { data: conversations, isLoading } = useConversations();

  if (conversationId) {
    return <ChatView conversationId={conversationId} />;
  }

  return (
    <AppLayout>
      <div className="px-4 py-2">
        <header className="flex items-center justify-between mb-4">
          <h1 className="text-lg font-bold tracking-tight">Messages</h1>
        </header>

        <div className="space-y-1">
          {isLoading ? (
            <div className="space-y-1">
              {[1, 2, 3].map(i => (
                <div key={i} className="flex gap-3 p-3 animate-pulse rounded-2xl">
                  <div className="w-12 h-12 rounded-full bg-muted" />
                  <div className="flex-1 space-y-2 py-1">
                    <div className="h-3.5 w-28 bg-muted rounded-lg" />
                    <div className="h-3 w-44 bg-muted rounded-lg" />
                  </div>
                </div>
              ))}
            </div>
          ) : conversations?.length === 0 ? (
            <div className="premium-card p-10 text-center">
              <p className="text-muted-foreground text-sm">Aucune conversation</p>
            </div>
          ) : (
            conversations?.map(conv => (
              <Link
                key={conv.id}
                to={`/messages/${conv.id}`}
                className={cn(
                  "flex items-center gap-3 p-3 rounded-2xl transition-all duration-200",
                  conv.unread_count > 0
                    ? "bg-primary/5 hover:bg-primary/10"
                    : "hover:bg-secondary/60"
                )}
              >
                <div className="relative">
                  <UserAvatar
                    src={conv.participant.avatar_url}
                    alt={conv.participant.name}
                    size="lg"
                  />
                  {/* Online indicator placeholder */}
                  <div className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-emerald-500 border-2 border-background" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className={cn(
                      "text-sm truncate",
                      conv.unread_count > 0 ? "font-bold" : "font-medium"
                    )}>
                      {conv.participant.name}
                    </span>
                    {conv.last_message && (
                      <span className="text-[10px] text-muted-foreground ml-2 flex-shrink-0">
                        {formatDistanceToNow(new Date(conv.last_message.created_at), { addSuffix: false, locale: fr })}
                      </span>
                    )}
                  </div>
                  <p className={cn(
                    "text-xs truncate mt-0.5",
                    conv.unread_count > 0 ? "text-foreground font-medium" : "text-muted-foreground"
                  )}>
                    {conv.last_message?.body || 'Démarrer une conversation'}
                  </p>
                </div>
                {conv.unread_count > 0 && (
                  <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center flex-shrink-0">
                    {conv.unread_count}
                  </span>
                )}
              </Link>
            ))
          )}
        </div>
      </div>
    </AppLayout>
  );
}

function ChatView({ conversationId }: { conversationId: string }) {
  const { user } = useAuth();
  const { data: conversations } = useConversations();
  const { data: messages, isLoading } = useMessages(conversationId);
  const sendMessage = useSendMessage();
  const markRead = useMarkConversationRead();
  const [newMessage, setNewMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const conversation = conversations?.find(c => c.id === conversationId);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (conversationId) {
      markRead.mutate(conversationId);
    }
  }, [conversationId]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim()) return;

    sendMessage.mutate(
      { conversationId, body: newMessage.trim() },
      { onSuccess: () => setNewMessage('') }
    );
  };

  return (
    <AppLayout>
      <div className="flex flex-col h-[calc(100vh-140px)] -mx-4 lg:-mx-4">
        {/* Chat Header */}
        <header className="flex items-center gap-3 px-4 py-3 glass border-b border-border/30">
          <Link to="/messages">
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          {conversation && (
            <Link to={`/profile/${conversation.participant.user_id}`} className="flex items-center gap-3 flex-1 min-w-0">
              <div className="relative">
                <UserAvatar
                  src={conversation.participant.avatar_url}
                  alt={conversation.participant.name}
                  size="md"
                />
                <div className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-background" />
              </div>
              <div className="min-w-0">
                <span className="text-sm font-semibold block truncate">{conversation.participant.name}</span>
                <span className="text-[10px] text-emerald-500 font-medium">En ligne</span>
              </div>
            </Link>
          )}
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-xs text-muted-foreground">Chargement…</span>
            </div>
          ) : messages?.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-xs text-muted-foreground">Commencez la conversation !</span>
            </div>
          ) : (
            messages?.map(msg => {
              const isMe = msg.sender_id === user?.id;
              return (
                <div
                  key={msg.id}
                  className={cn('flex gap-2', isMe ? 'flex-row-reverse' : '')}
                >
                  {!isMe && (
                    <UserAvatar src={msg.profile.avatar_url} alt={msg.profile.name} size="xs" />
                  )}
                  <div
                    className={cn(
                      'max-w-[75%] rounded-2xl px-3.5 py-2',
                      isMe
                        ? 'bg-primary text-primary-foreground rounded-br-md'
                        : 'bg-secondary rounded-bl-md'
                    )}
                  >
                    <p className="text-sm break-words leading-relaxed">{msg.body}</p>
                    <p className={cn(
                      'text-[10px] mt-0.5',
                      isMe ? 'text-primary-foreground/60' : 'text-muted-foreground'
                    )}>
                      {formatDistanceToNow(new Date(msg.created_at), { addSuffix: true, locale: fr })}
                    </p>
                  </div>
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <form onSubmit={handleSend} className="flex items-center gap-2 px-4 py-3 glass border-t border-border/30">
          <input
            value={newMessage}
            onChange={e => setNewMessage(e.target.value)}
            placeholder="Votre message…"
            className="flex-1 bg-secondary/60 rounded-full px-4 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus:bg-secondary transition-colors"
          />
          <Button 
            type="submit" 
            size="icon" 
            disabled={!newMessage.trim() || sendMessage.isPending}
            className="h-10 w-10 rounded-full premium-button p-0 flex-shrink-0"
          >
            <Send className="w-4 h-4" />
          </Button>
        </form>
      </div>
    </AppLayout>
  );
}
