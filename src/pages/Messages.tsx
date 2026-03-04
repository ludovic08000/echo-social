import { useState, useRef, useEffect, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Send, Search, Plus, ImageIcon, Smile, Check, CheckCheck, X, Phone, Video } from 'lucide-react';
import { formatDistanceToNow, format, isToday, isYesterday, isSameDay } from 'date-fns';
import { fr } from 'date-fns/locale';
import { AppLayout } from '@/components/AppLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConversations, useMessages, useSendMessage, useMarkConversationRead, useCreateConversation, type Message } from '@/hooks/useMessages';
import { useFriendships } from '@/hooks/useFriendships';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useCall } from '@/hooks/useCall';
import { CallOverlay } from '@/components/CallOverlay';

function formatMessageTime(dateStr: string) {
  const date = new Date(dateStr);
  if (isToday(date)) return format(date, 'HH:mm');
  if (isYesterday(date)) return 'Hier';
  return format(date, 'dd/MM/yy');
}

function formatDateSeparator(dateStr: string) {
  const date = new Date(dateStr);
  if (isToday(date)) return "Aujourd'hui";
  if (isYesterday(date)) return 'Hier';
  return format(date, 'EEEE d MMMM', { locale: fr });
}

// ─── New Conversation Dialog ─────────────────────────────
function NewConversationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const { data: friendsData, isLoading } = useFriendships();
  const createConversation = useCreateConversation();

  const friends = friendsData?.friends || [];
  const filtered = useMemo(() => {
    if (!search.trim()) return friends;
    const q = search.toLowerCase();
    return friends.filter(f => f.profile.name.toLowerCase().includes(q));
  }, [friends, search]);

  const handleSelect = async (friendUserId: string) => {
    try {
      const conv = await createConversation.mutateAsync(friendUserId);
      onOpenChange(false);
      navigate(`/messages/${conv.id}`);
    } catch (e) {
      console.error('Failed to create conversation:', e);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[80vh] flex flex-col p-0 gap-0 rounded-2xl">
        <DialogHeader className="p-4 pb-0">
          <DialogTitle className="text-base font-bold">Nouvelle conversation</DialogTitle>
        </DialogHeader>

        <div className="px-4 pt-3 pb-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Rechercher un ami…"
              className="w-full bg-secondary/60 rounded-xl pl-9 pr-4 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus:bg-secondary transition-colors"
              autoFocus
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Chargement…</div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-muted-foreground">
                {search ? 'Aucun ami trouvé' : 'Ajoutez des amis pour discuter'}
              </p>
            </div>
          ) : (
            filtered.map(friend => (
              <button
                key={friend.id}
                onClick={() => handleSelect(friend.profile.user_id)}
                disabled={createConversation.isPending}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-secondary/60 active:scale-[0.98] transition-all duration-200"
              >
                <UserAvatar src={friend.profile.avatar_url} alt={friend.profile.name} size="md" />
                <span className="text-sm font-medium truncate">{friend.profile.name}</span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Conversation List ───────────────────────────────────
function ConversationList() {
  const { data: conversations, isLoading } = useConversations();
  const [search, setSearch] = useState('');
  const [showNewChat, setShowNewChat] = useState(false);

  const filtered = useMemo(() => {
    if (!search.trim() || !conversations) return conversations;
    const q = search.toLowerCase();
    return conversations.filter(c => c.participant.name.toLowerCase().includes(q));
  }, [conversations, search]);

  return (
    <AppLayout>
      <div className="px-4 py-2">
        {/* Header */}
        <header className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold tracking-tight">Messages</h1>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-full bg-primary/10 text-primary hover:bg-primary/20"
            onClick={() => setShowNewChat(true)}
          >
            <Plus className="w-5 h-5" />
          </Button>
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
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
                <Send className="w-7 h-7 text-primary" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-foreground">
                  {search ? 'Aucun résultat' : 'Aucune conversation'}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {search ? 'Essayez un autre terme' : 'Commencez à discuter avec vos amis !'}
                </p>
              </div>
              {!search && (
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  onClick={() => setShowNewChat(true)}
                >
                  <Plus className="w-4 h-4 mr-1.5" />
                  Nouvelle conversation
                </Button>
              )}
            </div>
          ) : (
            filtered.map(conv => (
              <Link
                key={conv.id}
                to={`/messages/${conv.id}`}
                className={cn(
                  "flex items-center gap-3 p-3 rounded-2xl transition-all duration-200 active:scale-[0.98]",
                  conv.unread_count > 0
                    ? "bg-primary/5 hover:bg-primary/10"
                    : "hover:bg-secondary/60"
                )}
              >
                <div className="relative flex-shrink-0">
                  <UserAvatar
                    src={conv.participant.avatar_url}
                    alt={conv.participant.name}
                    size="lg"
                  />
                  <div className="absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full bg-emerald-500 border-[2.5px] border-background" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className={cn(
                      "text-sm truncate",
                      conv.unread_count > 0 ? "font-bold text-foreground" : "font-medium"
                    )}>
                      {conv.participant.name}
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
                      {conv.last_message?.body || 'Démarrez la conversation…'}
                    </p>
                    {conv.unread_count > 0 && (
                      <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center flex-shrink-0">
                        {conv.unread_count > 9 ? '9+' : conv.unread_count}
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            ))
          )}
        </div>
      </div>

      <NewConversationDialog open={showNewChat} onOpenChange={setShowNewChat} />
    </AppLayout>
  );
}

// ─── Chat View ───────────────────────────────────────────
function ChatView({ conversationId }: { conversationId: string }) {
  const { user } = useAuth();
  const { data: conversations } = useConversations();
  const { data: messages, isLoading } = useMessages(conversationId);
  const sendMessage = useSendMessage();
  const markRead = useMarkConversationRead();
  const [newMessage, setNewMessage] = useState('');
  const [showEmojis, setShowEmojis] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const conversation = conversations?.find(c => c.id === conversationId);

  const {
    callState,
    callType,
    isMuted,
    isCameraOff,
    duration,
    localVideoRef,
    remoteVideoRef,
    startCall,
    endCall,
    toggleMute,
    toggleCamera,
    switchToVideo,
    switchCamera,
  } = useCall();

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
        onSuccess: () => {
          setNewMessage('');
          inputRef.current?.focus();
        },
      }
    );
  };

  // Group messages by date
  const groupedMessages = useMemo(() => {
    if (!messages) return [];
    const groups: { date: string; messages: Message[] }[] = [];
    let currentGroup: { date: string; messages: Message[] } | null = null;

    messages.forEach(msg => {
      if (!currentGroup || !isSameDay(new Date(currentGroup.date), new Date(msg.created_at))) {
        currentGroup = { date: msg.created_at, messages: [] };
        groups.push(currentGroup);
      }
      currentGroup.messages.push(msg);
    });

    return groups;
  }, [messages]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Chat Header */}
      <header className="sticky top-0 z-40 glass border-b border-border/30 safe-area-pt">
        <div className="flex items-center gap-3 px-4 h-14">
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
          {/* Call buttons */}
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full text-primary"
              onClick={() => startCall(conversationId, 'audio')}
              disabled={callState !== 'idle'}
            >
              <Phone className="w-4.5 h-4.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full text-primary"
              onClick={() => startCall(conversationId, 'video')}
              disabled={callState !== 'idle'}
            >
              <Video className="w-4.5 h-4.5" />
            </Button>
          </div>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              <span className="text-xs text-muted-foreground">Chargement des messages…</span>
            </div>
          </div>
        ) : messages?.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Send className="w-7 h-7 text-primary" />
            </div>
            <p className="text-sm font-medium">Dites bonjour ! 👋</p>
            <p className="text-xs text-muted-foreground text-center max-w-[200px]">
              Envoyez votre premier message pour démarrer la conversation
            </p>
          </div>
        ) : (
          groupedMessages.map((group, gi) => (
            <div key={gi}>
              {/* Date separator */}
              <div className="flex items-center justify-center my-4">
                <span className="text-[10px] font-medium text-muted-foreground bg-muted/60 px-3 py-1 rounded-full capitalize">
                  {formatDateSeparator(group.date)}
                </span>
              </div>

              {/* Messages in this group */}
              <div className="space-y-1">
                {group.messages.map((msg, mi) => {
                  const isMe = msg.sender_id === user?.id;
                  const prevMsg = mi > 0 ? group.messages[mi - 1] : null;
                  const nextMsg = mi < group.messages.length - 1 ? group.messages[mi + 1] : null;
                  const isFirstInGroup = !prevMsg || prevMsg.sender_id !== msg.sender_id;
                  const isLastInGroup = !nextMsg || nextMsg.sender_id !== msg.sender_id;

                  return (
                    <div
                      key={msg.id}
                      className={cn(
                        'flex gap-2',
                        isMe ? 'flex-row-reverse' : '',
                        isFirstInGroup ? 'mt-3' : 'mt-0.5'
                      )}
                    >
                      {/* Avatar - only show for first message in group */}
                      {!isMe && (
                        <div className="w-7 flex-shrink-0">
                          {isLastInGroup && (
                            <UserAvatar src={msg.profile.avatar_url} alt={msg.profile.name} size="xs" />
                          )}
                        </div>
                      )}

                      <div className={cn('max-w-[75%] flex flex-col', isMe ? 'items-end' : 'items-start')}>
                        <div
                          className={cn(
                            'px-3.5 py-2 text-sm break-words leading-relaxed',
                            isMe
                              ? cn(
                                  'bg-primary text-primary-foreground',
                                  isFirstInGroup && isLastInGroup && 'rounded-2xl rounded-br-md',
                                  isFirstInGroup && !isLastInGroup && 'rounded-2xl rounded-br-sm',
                                  !isFirstInGroup && isLastInGroup && 'rounded-2xl rounded-tr-sm rounded-br-md',
                                  !isFirstInGroup && !isLastInGroup && 'rounded-2xl rounded-tr-sm rounded-br-sm'
                                )
                              : cn(
                                  'bg-secondary',
                                  isFirstInGroup && isLastInGroup && 'rounded-2xl rounded-bl-md',
                                  isFirstInGroup && !isLastInGroup && 'rounded-2xl rounded-bl-sm',
                                  !isFirstInGroup && isLastInGroup && 'rounded-2xl rounded-tl-sm rounded-bl-md',
                                  !isFirstInGroup && !isLastInGroup && 'rounded-2xl rounded-tl-sm rounded-bl-sm'
                                )
                          )}
                        >
                          {msg.body}
                        </div>

                        {/* Timestamp - only on last message in group */}
                        {isLastInGroup && (
                          <div className={cn(
                            'flex items-center gap-1 mt-1 px-1',
                            isMe ? 'flex-row-reverse' : ''
                          )}>
                            <span className="text-[10px] text-muted-foreground">
                              {format(new Date(msg.created_at), 'HH:mm')}
                            </span>
                            {isMe && (
                              <CheckCheck className="w-3 h-3 text-primary/60" />
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Emoji Picker */}
      {showEmojis && (
        <div className="sticky bottom-14 z-30 glass border-t border-border/20 animate-in slide-in-from-bottom-4 duration-200">
          <div className="px-2 py-3 max-h-[220px] overflow-y-auto scrollbar-thin">
            {[
              { label: '😀 Visages', emojis: ['😀','😂','🤣','😍','🥰','😘','😎','🤩','🥳','😇','🤗','🤭','😏','😌','🥺','😢','😭','😡','🤯','🫠','😴','🤑','🫡','🫶'] },
              { label: '❤️ Cœurs', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💖','💝','💘','💕','💗','💓','❤️‍🔥','💔','🫀'] },
              { label: '👋 Gestes', emojis: ['👋','👍','👎','👏','🙌','🤝','✌️','🤞','🤟','🤙','💪','🫰','👊','✊','🤌','🫶','🙏'] },
              { label: '🎉 Fête', emojis: ['🎉','🎊','🎈','🎁','🏆','🥇','⭐','🌟','✨','🔥','💥','💫','🎵','🎶','🎤','🎸'] },
              { label: '🍕 Nourriture', emojis: ['🍕','🍔','🍟','🌮','🍣','🍩','🍰','🧁','☕','🍷','🍺','🥂','🧋','🍓','🍑','🥑'] },
              { label: '🐱 Animaux', emojis: ['🐱','🐶','🐻','🦊','🐼','🐨','🦁','🐸','🐵','🦋','🐝','🌸','🌺','🌻','🌈','☀️'] },
              { label: '💎 Premium', emojis: ['💎','👑','🦄','🌙','⚡','🪐','🔮','🎭','🗝️','🧿','🪬','💐','🦚','🎪','🏰','🚀','🛸','🧬'] },
            ].map((cat) => (
              <div key={cat.label} className="mb-2">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-2 mb-1.5">{cat.label}</p>
                <div className="flex flex-wrap gap-0.5">
                  {cat.emojis.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => {
                        setNewMessage(prev => prev + emoji);
                        inputRef.current?.focus();
                      }}
                      className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-secondary/80 active:scale-90 transition-all text-lg"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Input bar */}
      <div className="sticky bottom-0 glass border-t border-border/30 safe-area-pb">
        <form onSubmit={handleSend} className="flex items-center gap-2 px-3 py-2.5">
          <div className="flex-1 flex items-center gap-2 bg-secondary/60 rounded-full px-4 py-2 focus-within:bg-secondary transition-colors">
            <button
              type="button"
              onClick={() => setShowEmojis(v => !v)}
              className={cn(
                "w-7 h-7 rounded-full flex items-center justify-center transition-all flex-shrink-0",
                showEmojis
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Smile className="w-5 h-5" />
            </button>
            <input
              ref={inputRef}
              value={newMessage}
              onChange={e => setNewMessage(e.target.value)}
              onFocus={() => setShowEmojis(false)}
              placeholder="Votre message…"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground min-w-0"
            />
          </div>
          <Button
            type="submit"
            size="icon"
            disabled={!newMessage.trim() || sendMessage.isPending}
            className={cn(
              "h-10 w-10 rounded-full flex-shrink-0 transition-all duration-200",
              newMessage.trim()
                ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20 scale-100"
                : "bg-secondary text-muted-foreground scale-95"
            )}
          >
            <Send className="w-4 h-4" />
          </Button>
        </form>
      </div>
      {/* Call overlay */}
      <CallOverlay
        callState={callState}
        callType={callType}
        isMuted={isMuted}
        isCameraOff={isCameraOff}
        duration={duration}
        participantName={conversation?.participant.name || ''}
        participantAvatar={conversation?.participant.avatar_url}
        localVideoRef={localVideoRef}
        remoteVideoRef={remoteVideoRef}
        onEndCall={endCall}
        onToggleMute={toggleMute}
        onToggleCamera={toggleCamera}
        onSwitchToVideo={switchToVideo}
        onSwitchCamera={switchCamera}
      />
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────
export default function Messages() {
  const { conversationId } = useParams<{ conversationId?: string }>();

  if (conversationId) {
    return <ChatView conversationId={conversationId} />;
  }

  return <ConversationList />;
}
