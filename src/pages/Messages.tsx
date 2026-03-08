import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, Send, Search, Plus, ImageIcon, Smile, Check, CheckCheck, 
  X, Phone, Video, Mic, MicOff, Reply, Heart, ThumbsUp, Laugh, 
  Flame, Sparkles, Camera, Paperclip, MoreVertical, Trash2, Copy,
  ChevronDown
} from 'lucide-react';
import { formatDistanceToNow, format, isToday, isYesterday, isSameDay } from 'date-fns';
import { fr } from 'date-fns/locale';
import { AppLayout } from '@/components/AppLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConversations, useMessages, useSendMessage, useMarkConversationRead, useCreateConversation, useCreateGroupConversation, type Message } from '@/hooks/useMessages';
import { useFriendships } from '@/hooks/useFriendships';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useCall } from '@/hooks/useCall';
import { CallOverlay } from '@/components/CallOverlay';
import { useImageUpload } from '@/hooks/useImageUpload';
import { toast } from 'sonner';

// ─── Utils ───────────────────────────────────────────────
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

const MESSAGE_REACTIONS = [
  { emoji: '❤️', label: 'love' },
  { emoji: '👍', label: 'like' },
  { emoji: '😂', label: 'laugh' },
  { emoji: '😮', label: 'wow' },
  { emoji: '😢', label: 'sad' },
  { emoji: '🔥', label: 'fire' },
];

const EMOJI_CATEGORIES = [
  { label: '😀 Visages', emojis: ['😀','😂','🤣','😍','🥰','😘','😎','🤩','🥳','😇','🤗','🤭','😏','😌','🥺','😢','😭','😡','🤯','🫠','😴','🤑','🫡','🫶'] },
  { label: '❤️ Cœurs', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💖','💝','💘','💕','💗','💓','❤️‍🔥','💔','🫀'] },
  { label: '👋 Gestes', emojis: ['👋','👍','👎','👏','🙌','🤝','✌️','🤞','🤟','🤙','💪','🫰','👊','✊','🤌','🫶','🙏'] },
  { label: '🎉 Fête', emojis: ['🎉','🎊','🎈','🎁','🏆','🥇','⭐','🌟','✨','🔥','💥','💫','🎵','🎶','🎤','🎸'] },
  { label: '🍕 Nourriture', emojis: ['🍕','🍔','🍟','🌮','🍣','🍩','🍰','🧁','☕','🍷','🍺','🥂','🧋','🍓','🍑','🥑'] },
  { label: '🐱 Nature', emojis: ['🐱','🐶','🐻','🦊','🐼','🐨','🦁','🐸','🐵','🦋','🐝','🌸','🌺','🌻','🌈','☀️'] },
  { label: '💎 Premium', emojis: ['💎','👑','🦄','🌙','⚡','🪐','🔮','🎭','🗝️','🧿','🪬','💐','🦚','🎪','🏰','🚀','🛸','🧬'] },
];

// Check if message body is a single emoji (for big emoji display)
function isSingleEmoji(text: string): boolean {
  const emojiRegex = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic}){1,3}$/u;
  return emojiRegex.test(text.trim());
}

// ─── Voice Message Button ────────────────────────────────
function VoiceRecordButton({ onSend }: { onSend: (text: string) => void }) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  const toggleRecording = () => {
    if (isRecording) {
      clearInterval(timerRef.current);
      // Simulate sending voice message
      onSend(`🎙️ Message vocal (${recordDuration}s)`);
      setRecordDuration(0);
      setIsRecording(false);
    } else {
      setIsRecording(true);
      setRecordDuration(0);
      timerRef.current = setInterval(() => {
        setRecordDuration(d => d + 1);
      }, 1000);
    }
  };

  useEffect(() => {
    return () => clearInterval(timerRef.current);
  }, []);

  return (
    <div className="flex items-center gap-2">
      {isRecording && (
        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-destructive/10 animate-pulse">
          <div className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
          <span className="text-xs font-medium text-destructive tabular-nums">
            {Math.floor(recordDuration / 60)}:{(recordDuration % 60).toString().padStart(2, '0')}
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={toggleRecording}
        className={cn(
          "h-10 w-10 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-300",
          isRecording 
            ? "bg-destructive text-destructive-foreground shadow-lg shadow-destructive/30 scale-110 animate-pulse" 
            : "bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80"
        )}
      >
        {isRecording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
      </button>
    </div>
  );
}

// ─── Typing Indicator ────────────────────────────────────
function TypingIndicator({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="flex gap-1 bg-secondary rounded-2xl px-4 py-2.5">
        <div className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '0ms' }} />
        <div className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '150ms' }} />
        <div className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
      <span className="text-[10px] text-muted-foreground italic">{name} écrit…</span>
    </div>
  );
}

// ─── Message Reactions Picker ────────────────────────────
function ReactionPicker({ onReact, visible }: { onReact: (emoji: string) => void; visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="flex items-center gap-0.5 px-1.5 py-1 rounded-full glass shadow-lg border border-border/30 animate-in zoom-in-75 duration-200">
      {MESSAGE_REACTIONS.map(r => (
        <button
          key={r.label}
          onClick={() => onReact(r.emoji)}
          className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-secondary/80 active:scale-75 transition-all text-base"
        >
          {r.emoji}
        </button>
      ))}
    </div>
  );
}

// ─── Message Context Menu ────────────────────────────────
function MessageActions({ 
  isMe, onReply, onReact, onCopy, onDelete, visible, onClose 
}: { 
  isMe: boolean; 
  onReply: () => void; 
  onReact: (emoji: string) => void;
  onCopy: () => void; 
  onDelete?: () => void; 
  visible: boolean; 
  onClose: () => void;
}) {
  if (!visible) return null;
  
  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} />
      <div className={cn(
        "absolute z-50 flex flex-col gap-1 animate-in zoom-in-95 duration-150",
        isMe ? "right-0 -top-20" : "left-8 -top-20"
      )}>
        {/* Reactions row */}
        <div className="flex items-center gap-0.5 px-1.5 py-1 rounded-full glass shadow-xl border border-border/30">
          {MESSAGE_REACTIONS.map(r => (
            <button
              key={r.label}
              onClick={() => { onReact(r.emoji); onClose(); }}
              className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-secondary/80 hover:scale-125 active:scale-90 transition-all text-lg"
            >
              {r.emoji}
            </button>
          ))}
        </div>
        {/* Actions */}
        <div className="glass shadow-xl rounded-xl border border-border/30 overflow-hidden min-w-[160px]">
          <button onClick={() => { onReply(); onClose(); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-secondary/60 transition-colors">
            <Reply className="w-4 h-4 text-muted-foreground" /> Répondre
          </button>
          <button onClick={() => { onCopy(); onClose(); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-secondary/60 transition-colors">
            <Copy className="w-4 h-4 text-muted-foreground" /> Copier
          </button>
          {isMe && onDelete && (
            <button onClick={() => { onDelete(); onClose(); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-destructive hover:bg-destructive/10 transition-colors">
              <Trash2 className="w-4 h-4" /> Supprimer
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ─── New Conversation Dialog ─────────────────────────────
function NewConversationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'single' | 'group'>('single');
  const [groupName, setGroupName] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const { data: friendsData, isLoading } = useFriendships();
  const createConversation = useCreateConversation();
  const createGroup = useCreateGroupConversation();

  const friends = friendsData?.friends || [];
  const filtered = useMemo(() => {
    if (!search.trim()) return friends;
    const q = search.toLowerCase();
    return friends.filter(f => f.profile.name.toLowerCase().includes(q));
  }, [friends, search]);

  const handleSelect = async (friendUserId: string) => {
    if (mode === 'group') {
      setSelectedMembers(prev =>
        prev.includes(friendUserId)
          ? prev.filter(id => id !== friendUserId)
          : [...prev, friendUserId]
      );
      return;
    }
    try {
      const conv = await createConversation.mutateAsync(friendUserId);
      onOpenChange(false);
      navigate(`/messages/${conv.id}`);
    } catch (e) {
      console.error('Failed to create conversation:', e);
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
            filtered.map(friend => {
              const isSelected = selectedMembers.includes(friend.profile.user_id);
              return (
                <button
                  key={friend.id}
                  onClick={() => handleSelect(friend.profile.user_id)}
                  disabled={createConversation.isPending || createGroup.isPending}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-secondary/60 active:scale-[0.98] transition-all duration-200",
                    mode === 'group' && isSelected && "bg-primary/10 ring-1 ring-primary/30"
                  )}
                >
                  <UserAvatar src={friend.profile.avatar_url} alt={friend.profile.name} size="md" />
                  <span className="text-sm font-medium truncate flex-1 text-left">{friend.profile.name}</span>
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
              <Link
                key={conv.id}
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
                      <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center flex-shrink-0 shadow-sm shadow-primary/30">
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

// ─── Premium Chat View ───────────────────────────────────
function ChatView({ conversationId }: { conversationId: string }) {
  const { user } = useAuth();
  const { data: conversations } = useConversations();
  const { data: messages, isLoading } = useMessages(conversationId);
  const sendMessage = useSendMessage();
  const markRead = useMarkConversationRead();
  const [newMessage, setNewMessage] = useState('');
  const [showEmojis, setShowEmojis] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [messageReactions, setMessageReactions] = useState<Record<string, string[]>>({});
  const [isTyping, setIsTyping] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const conversation = conversations?.find(c => c.id === conversationId);

  const { upload, isUploading } = useImageUpload({
    bucket: 'post-images',
    onSuccess: (url) => {
      sendMessage.mutate({ conversationId, body: '📷 Photo', imageUrl: url });
    },
  });

  const {
    callState, callType, isMuted, isCameraOff, duration,
    localVideoRef, remoteVideoRef,
    startCall, endCall, toggleMute, toggleCamera, switchToVideo, switchCamera,
  } = useCall();

  // Simulate typing indicator
  useEffect(() => {
    if (newMessage.length > 0) {
      const t = setTimeout(() => setIsTyping(true), 500);
      const t2 = setTimeout(() => setIsTyping(false), 3000);
      return () => { clearTimeout(t); clearTimeout(t2); };
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (conversationId) markRead.mutate(conversationId);
  }, [conversationId]);

  // Scroll detection
  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    setShowScrollDown(scrollHeight - scrollTop - clientHeight > 200);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim()) return;

    const body = replyTo 
      ? `↩️ ${replyTo.profile.name}: "${replyTo.body.slice(0, 50)}${replyTo.body.length > 50 ? '…' : ''}"\n\n${newMessage.trim()}`
      : newMessage.trim();

    sendMessage.mutate(
      { conversationId, body },
      {
        onSuccess: () => {
          setNewMessage('');
          setReplyTo(null);
          setShowEmojis(false);
          inputRef.current?.focus();
        },
      }
    );
  };

  const handleImageUpload = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) upload(file);
    e.target.value = '';
  };

  const handleReact = (msgId: string, emoji: string) => {
    setMessageReactions(prev => {
      const existing = prev[msgId] || [];
      if (existing.includes(emoji)) {
        return { ...prev, [msgId]: existing.filter(e => e !== emoji) };
      }
      return { ...prev, [msgId]: [...existing, emoji] };
    });
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Message copié');
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
      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />

      {/* Premium Chat Header */}
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
                <UserAvatar src={conversation.participant.avatar_url} alt={conversation.participant.name} size="md" />
                <div className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-background ring-2 ring-emerald-500/20" />
              </div>
              <div className="min-w-0">
                <span className="text-sm font-semibold block truncate">{conversation.participant.name}</span>
                <span className="text-[10px] text-emerald-500 font-medium flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  En ligne
                </span>
              </div>
            </Link>
          )}
          {/* Call buttons */}
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full text-primary hover:bg-primary/10"
              onClick={() => startCall(conversationId, 'audio')}
              disabled={callState !== 'idle'}
            >
              <Phone className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full text-primary hover:bg-primary/10"
              onClick={() => startCall(conversationId, 'video')}
              disabled={callState !== 'idle'}
            >
              <Video className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Messages area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 relative"
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="flex flex-col items-center gap-3">
              <div className="w-10 h-10 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              <span className="text-xs text-muted-foreground">Chargement des messages…</span>
            </div>
          </div>
        ) : messages?.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-4">
            <div className="relative">
              <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-primary/20 to-accent/30 flex items-center justify-center">
                <Send className="w-8 h-8 text-primary" />
              </div>
              <Sparkles className="w-5 h-5 text-primary absolute -top-1 -right-1 animate-pulse" />
            </div>
            <div className="text-center">
              <p className="text-base font-semibold">Dites bonjour ! 👋</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-[220px]">
                Envoyez votre premier message pour démarrer la conversation
              </p>
            </div>
            {/* Quick message suggestions */}
            <div className="flex flex-wrap gap-2 justify-center max-w-[300px]">
              {['Salut ! 👋', 'Comment ça va ? 😊', 'Quoi de neuf ? 🤔', 'Hey ! ✨'].map(suggestion => (
                <button
                  key={suggestion}
                  onClick={() => {
                    sendMessage.mutate({ conversationId, body: suggestion });
                  }}
                  className="px-4 py-2 rounded-full bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 active:scale-95 transition-all"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          groupedMessages.map((group, gi) => (
            <div key={gi}>
              {/* Date separator */}
              <div className="flex items-center justify-center my-5">
                <div className="h-px flex-1 bg-border/30" />
                <span className="text-[10px] font-medium text-muted-foreground bg-background px-4 py-1 capitalize">
                  {formatDateSeparator(group.date)}
                </span>
                <div className="h-px flex-1 bg-border/30" />
              </div>

              {/* Messages */}
              <div className="space-y-1">
                {group.messages.map((msg, mi) => {
                  const isMe = msg.sender_id === user?.id;
                  const prevMsg = mi > 0 ? group.messages[mi - 1] : null;
                  const nextMsg = mi < group.messages.length - 1 ? group.messages[mi + 1] : null;
                  const isFirstInGroup = !prevMsg || prevMsg.sender_id !== msg.sender_id;
                  const isLastInGroup = !nextMsg || nextMsg.sender_id !== msg.sender_id;
                  const reactions = messageReactions[msg.id] || [];
                  const isBigEmoji = isSingleEmoji(msg.body);
                  const isImage = msg.image_url;

                  return (
                    <div
                      key={msg.id}
                      className={cn(
                        'flex gap-2 relative group',
                        isMe ? 'flex-row-reverse' : '',
                        isFirstInGroup ? 'mt-3' : 'mt-0.5'
                      )}
                    >
                      {/* Avatar */}
                      {!isMe && (
                        <div className="w-7 flex-shrink-0">
                          {isLastInGroup && (
                            <UserAvatar src={msg.profile.avatar_url} alt={msg.profile.name} size="xs" />
                          )}
                        </div>
                      )}

                      <div className={cn('max-w-[75%] flex flex-col relative', isMe ? 'items-end' : 'items-start')}>
                        {/* Message actions (on long press / hover) */}
                        <MessageActions
                          isMe={isMe}
                          visible={activeMessageId === msg.id}
                          onClose={() => setActiveMessageId(null)}
                          onReply={() => setReplyTo(msg)}
                          onReact={(emoji) => handleReact(msg.id, emoji)}
                          onCopy={() => handleCopy(msg.body)}
                          onDelete={isMe ? () => toast.info('Suppression non disponible en démo') : undefined}
                        />

                        {/* Image message */}
                        {isImage && (
                          <div className="rounded-2xl overflow-hidden mb-1 shadow-sm">
                            <img src={msg.image_url!} alt="Photo" className="max-w-full max-h-[300px] object-cover" />
                          </div>
                        )}

                        {/* Message bubble */}
                        <div
                          onClick={() => setActiveMessageId(activeMessageId === msg.id ? null : msg.id)}
                          className={cn(
                            'cursor-pointer select-none transition-all duration-150',
                            activeMessageId === msg.id && 'scale-[0.97]',
                            isBigEmoji
                              ? 'text-4xl leading-none py-1'
                              : cn(
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
                                )
                          )}
                        >
                          {msg.body}
                        </div>

                        {/* Reactions display */}
                        {reactions.length > 0 && (
                          <div className={cn(
                            "flex items-center gap-0.5 -mt-1.5 px-1",
                            isMe ? "flex-row-reverse" : ""
                          )}>
                            <div className="flex items-center gap-0 bg-background border border-border/40 rounded-full px-1.5 py-0.5 shadow-sm">
                              {reactions.map((r, i) => (
                                <span key={i} className="text-xs">{r}</span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Timestamp + read receipt */}
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

        {/* Typing indicator */}
        {isTyping && conversation && (
          <TypingIndicator name={conversation.participant.name} />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Scroll to bottom FAB */}
      {showScrollDown && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-32 right-4 z-30 w-10 h-10 rounded-full glass shadow-xl border border-border/30 flex items-center justify-center hover:bg-secondary transition-colors animate-in zoom-in-75"
        >
          <ChevronDown className="w-5 h-5 text-muted-foreground" />
        </button>
      )}

      {/* Reply preview */}
      {replyTo && (
        <div className="sticky bottom-[108px] z-20 mx-4 glass border border-border/30 rounded-xl px-4 py-2.5 flex items-center gap-3 animate-in slide-in-from-bottom-2 duration-200">
          <div className="w-1 h-8 rounded-full bg-primary flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-semibold text-primary">
              Réponse à {replyTo.sender_id === user?.id ? 'vous-même' : replyTo.profile.name}
            </p>
            <p className="text-xs text-muted-foreground truncate">{replyTo.body}</p>
          </div>
          <button onClick={() => setReplyTo(null)} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Emoji Picker */}
      {showEmojis && (
        <div className="sticky bottom-14 z-30 glass border-t border-border/20 animate-in slide-in-from-bottom-4 duration-200">
          <div className="px-2 py-3 max-h-[220px] overflow-y-auto scrollbar-thin">
            {EMOJI_CATEGORIES.map((cat) => (
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

      {/* Premium Input Bar */}
      <div className="sticky bottom-0 glass border-t border-border/30 safe-area-pb">
        <form onSubmit={handleSend} className="flex items-center gap-2 px-3 py-2.5">
          {/* Attachments */}
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={handleImageUpload}
              disabled={isUploading}
              className="w-9 h-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all"
            >
              {isUploading ? (
                <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              ) : (
                <Camera className="w-5 h-5" />
              )}
            </button>
          </div>

          {/* Input */}
          <div className="flex-1 flex items-center gap-2 bg-secondary/60 rounded-full px-4 py-2 focus-within:bg-secondary focus-within:ring-2 focus-within:ring-primary/20 transition-all">
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

          {/* Send or Voice */}
          {newMessage.trim() ? (
            <Button
              type="submit"
              size="icon"
              disabled={sendMessage.isPending}
              className="h-10 w-10 rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:shadow-primary/40 transition-all duration-200 animate-in zoom-in-75"
            >
              <Send className="w-4 h-4" />
            </Button>
          ) : (
            <VoiceRecordButton onSend={(text) => sendMessage.mutate({ conversationId, body: text })} />
          )}
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
