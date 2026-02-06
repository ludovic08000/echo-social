import { useState, useRef, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Send, Image } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { AppLayout } from '@/components/AppLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
      <header className="flex items-center gap-3 mb-4">
        <h1 className="text-xl font-bold">Messages</h1>
      </header>

      <div className="pulse-card overflow-hidden divide-y divide-border">
        {isLoading ? (
          <div className="p-4 space-y-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="flex gap-3 animate-pulse">
                <div className="w-12 h-12 rounded-full bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 bg-muted rounded" />
                  <div className="h-3 w-48 bg-muted rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : conversations?.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">
            Aucune conversation
          </div>
        ) : (
          conversations?.map(conv => (
            <Link
              key={conv.id}
              to={`/messages/${conv.id}`}
              className="flex items-center gap-3 p-4 hover:bg-accent transition-colors"
            >
              <UserAvatar
                src={conv.participant.avatar_url}
                alt={conv.participant.name}
                size="lg"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="font-medium truncate">{conv.participant.name}</span>
                  {conv.last_message && (
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(conv.last_message.created_at), { addSuffix: true, locale: fr })}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground truncate">
                  {conv.last_message?.body || 'Démarrer une conversation'}
                </p>
              </div>
              {conv.unread_count > 0 && (
                <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center">
                  {conv.unread_count}
                </span>
              )}
            </Link>
          ))
        )}
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
      {
        onSuccess: () => setNewMessage(''),
      }
    );
  };

  return (
    <AppLayout>
      <div className="flex flex-col h-[calc(100vh-140px)]">
        {/* Header */}
        <header className="flex items-center gap-3 pb-4 border-b border-border">
          <Link to="/messages">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          {conversation && (
            <Link to={`/profile/${conversation.participant.user_id}`} className="flex items-center gap-3">
              <UserAvatar
                src={conversation.participant.avatar_url}
                alt={conversation.participant.name}
                size="md"
              />
              <span className="font-semibold">{conversation.participant.name}</span>
            </Link>
          )}
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto py-4 space-y-3">
          {isLoading ? (
            <div className="text-center text-muted-foreground">Chargement...</div>
          ) : messages?.length === 0 ? (
            <div className="text-center text-muted-foreground">
              Commencez la conversation !
            </div>
          ) : (
            messages?.map(msg => (
              <div
                key={msg.id}
                className={cn(
                  'flex gap-2',
                  msg.sender_id === user?.id ? 'flex-row-reverse' : ''
                )}
              >
                {msg.sender_id !== user?.id && (
                  <UserAvatar
                    src={msg.profile.avatar_url}
                    alt={msg.profile.name}
                    size="sm"
                  />
                )}
                <div
                  className={cn(
                    'max-w-[70%] rounded-2xl px-4 py-2',
                    msg.sender_id === user?.id
                      ? 'bg-primary text-primary-foreground rounded-br-md'
                      : 'bg-muted rounded-bl-md'
                  )}
                >
                  <p className="break-words">{msg.body}</p>
                  <p className={cn(
                    'text-xs mt-1',
                    msg.sender_id === user?.id ? 'text-primary-foreground/70' : 'text-muted-foreground'
                  )}>
                    {formatDistanceToNow(new Date(msg.created_at), { addSuffix: true, locale: fr })}
                  </p>
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <form onSubmit={handleSend} className="flex gap-2 pt-4 border-t border-border">
          <Input
            value={newMessage}
            onChange={e => setNewMessage(e.target.value)}
            placeholder="Votre message..."
            className="flex-1"
          />
          <Button type="submit" disabled={!newMessage.trim() || sendMessage.isPending}>
            <Send className="w-4 h-4" />
          </Button>
        </form>
      </div>
    </AppLayout>
  );
}
