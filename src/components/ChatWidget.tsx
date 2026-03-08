import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, Send, Search, Plus, X, Phone, Video, Mic, MicOff,
  Smile, Check, CheckCheck, Minus, Camera, Reply, Copy, Trash2,
  ChevronDown, Sparkles, MoreVertical, ThumbsUp, ImageIcon, PhoneOff, PhoneMissed,
  Flag, Forward, Wand2, Languages, SpellCheck, PenLine, Tag, ArrowRightLeft, CreditCard, XIcon
} from 'lucide-react';
import { formatDistanceToNow, format, isToday, isYesterday, isSameDay } from 'date-fns';
import { fr } from 'date-fns/locale';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConversations, useMessages, useSendMessage, useMarkConversationRead, useCreateConversation, useDeleteMessageForMe, useDeleteMessageForEveryone, useHasPendingMessages, useAcceptMessageRequest, useRejectMessageRequest, type Message } from '@/hooks/useMessages';
import { useNegotiations, useCreateNegotiation, useRespondNegotiation, useAcceptCounterOffer, type Negotiation } from '@/hooks/useNegotiations';
import { useFriendships } from '@/hooks/useFriendships';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { trackAICall } from '@/lib/aiEngine';
import { cn } from '@/lib/utils';
import { useChatWidget } from './ChatWidgetContext';
import { useImageUpload } from '@/hooks/useImageUpload';
import { useCall, formatCallDuration, type CallEndInfo } from '@/hooks/useCall';
import { CallOverlay } from '@/components/CallOverlay';
import { GifPicker } from '@/components/chat/GifPicker';
import { VoiceRecorder, VoiceMessagePlayer } from '@/components/chat/VoiceRecorder';
import { useRealtimeNotificationSound } from '@/hooks/useNotificationSounds';
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

function isSingleEmoji(text: string): boolean {
  const emojiRegex = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic}){1,3}$/u;
  return emojiRegex.test(text.trim());
}

const MESSAGE_REACTIONS = [
  { emoji: '❤️', label: 'love' },
  { emoji: '👍', label: 'like' },
  { emoji: '😂', label: 'laugh' },
  { emoji: '😮', label: 'wow' },
  { emoji: '😢', label: 'sad' },
  { emoji: '🔥', label: 'fire' },
];

const URL_REGEX = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/;
const URL_REGEX_G = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g;

function MessageBodyWithLinks({ body, isMe }: { body: string; isMe: boolean }) {
  if (!URL_REGEX.test(body)) return <>{body}</>;
  const parts = body.split(URL_REGEX_G);
  return (
    <>
      {parts.map((part, i) =>
        URL_REGEX.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className={cn(
              'underline break-all',
              isMe ? 'text-primary-foreground/90 hover:text-primary-foreground' : 'text-primary hover:text-primary/80'
            )}
          >
            {part.length > 50 ? part.slice(0, 47) + '…' : part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

const EMOJI_CATEGORIES = [
  { label: '😀 Visages', emojis: ['😀','😂','🤣','😍','🥰','😘','😎','🤩','🥳','😇','🤗','🤭','😏','😌','🥺','😢','😭','😡','🤯','🫠','😴','🤑','🫡','🫶'] },
  { label: '❤️ Cœurs', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💖','💝','💘','💕','💗','💓','❤️‍🔥','💔','🫀'] },
  { label: '👋 Gestes', emojis: ['👋','👍','👎','👏','🙌','🤝','✌️','🤞','🤟','🤙','💪','🫰','👊','✊','🤌','🫶','🙏'] },
  { label: '🎉 Fête', emojis: ['🎉','🎊','🎈','🎁','🏆','🥇','⭐','🌟','✨','🔥','💥','💫','🎵','🎶','🎤','🎸'] },
  { label: '💎 Premium', emojis: ['💎','👑','🦄','🌙','⚡','🪐','🔮','🎭','🗝️','🧿','🪬','💐','🦚','🎪','🏰','🚀','🛸','🧬'] },
];

// Helper to detect voice messages, GIFs, and call events
function isVoiceMessage(body: string): boolean {
  return body.startsWith('🎙️ ') && body.includes('voice:');
}

function getVoiceData(body: string): { url: string; duration: number } | null {
  const match = body.match(/voice:(.*?)(?:\|dur:(\d+))?$/);
  if (!match) return null;
  return { url: match[1], duration: parseInt(match[2] || '0', 10) };
}

function isGifMessage(body: string): boolean {
  return body.startsWith('GIF:');
}

function getGifUrl(body: string): string {
  return body.replace('GIF:', '');
}

function isCallMessage(body: string): boolean {
  return body.startsWith('📞 CALL:');
}

function getCallData(body: string): { status: 'missed' | 'ended'; callType: 'audio' | 'video'; duration?: number } | null {
  const match = body.match(/📞 CALL:(missed|ended)\|(audio|video)(?:\|dur:(\d+))?/);
  if (!match) return null;
  return {
    status: match[1] as 'missed' | 'ended',
    callType: match[2] as 'audio' | 'video',
    duration: match[3] ? parseInt(match[3], 10) : undefined,
  };
}

// ─── New Conversation Dialog ─────────────────────────────
function NewConversationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [search, setSearch] = useState('');
  const { data: friendsData, isLoading } = useFriendships();
  const createConversation = useCreateConversation();
  const { openConversation } = useChatWidget();

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
      openConversation(conv.id);
    } catch (e) {
      console.error('Failed to create conversation:', e);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm max-h-[60vh] flex flex-col p-0 gap-0 rounded-2xl">
        <DialogHeader className="p-3 pb-0">
          <DialogTitle className="text-sm font-bold">Nouvelle conversation</DialogTitle>
        </DialogHeader>
        <div className="px-3 pt-2 pb-1">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Rechercher un ami…"
              className="w-full bg-secondary/60 rounded-xl pl-8 pr-3 py-2 text-xs outline-none placeholder:text-muted-foreground focus:bg-secondary transition-colors"
              autoFocus
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-1.5 pb-3">
          {isLoading ? (
            <div className="py-6 text-center text-xs text-muted-foreground">Chargement…</div>
          ) : filtered.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {search ? 'Aucun ami trouvé' : 'Ajoutez des amis pour discuter'}
            </div>
          ) : (
            filtered.map(friend => (
              <button
                key={friend.id}
                onClick={() => handleSelect(friend.profile.user_id)}
                disabled={createConversation.isPending}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl hover:bg-secondary/60 transition-all text-left"
              >
                <UserAvatar src={friend.profile.avatar_url} alt={friend.profile.name} size="sm" />
                <span className="text-xs font-medium truncate">{friend.profile.name}</span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Conversation List (inside widget) ───────────────────
function WidgetConversationList() {
  const { data: conversations, isLoading } = useConversations();
  const [search, setSearch] = useState('');
  const [showNewChat, setShowNewChat] = useState(false);
  const { closeChat, minimizeChat, openConversation } = useChatWidget();

  const filtered = useMemo(() => {
    if (!search.trim() || !conversations) return conversations;
    const q = search.toLowerCase();
    return conversations.filter(c => c.participant.name.toLowerCase().includes(q));
  }, [conversations, search]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/30 bg-primary text-primary-foreground rounded-t-lg">
        <span className="text-sm font-bold">Messagerie</span>
        <div className="flex items-center gap-0.5">
          <button onClick={() => setShowNewChat(true)} className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-primary-foreground/20 transition-colors">
            <Plus className="w-4 h-4" />
          </button>
          <button onClick={minimizeChat} className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-primary-foreground/20 transition-colors">
            <Minus className="w-4 h-4" />
          </button>
          <button onClick={closeChat} className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-primary-foreground/20 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-2.5 pt-2.5 pb-1.5">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Rechercher…"
            className="w-full bg-secondary/60 rounded-full pl-8 pr-3 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:bg-secondary transition-colors"
          />
        </div>
      </div>

      {/* Conversations */}
      <div className="flex-1 overflow-y-auto px-1.5">
        {isLoading ? (
          <div className="space-y-1 p-2">
            {[1,2,3].map(i => (
              <div key={i} className="flex gap-2 p-2 animate-pulse">
                <div className="w-10 h-10 rounded-full bg-muted flex-shrink-0" />
                <div className="flex-1 space-y-1.5 py-1">
                  <div className="h-3 w-20 bg-muted rounded" />
                  <div className="h-2.5 w-32 bg-muted rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : !filtered?.length ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <Send className="w-6 h-6 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">{search ? 'Aucun résultat' : 'Aucune conversation'}</p>
            {!search && (
              <button
                onClick={() => setShowNewChat(true)}
                className="text-xs text-primary font-medium hover:underline"
              >
                Nouvelle conversation
              </button>
            )}
          </div>
        ) : (
          filtered.map(conv => (
            <button
              key={conv.id}
              onClick={() => openConversation(conv.id)}
              className={cn(
                "w-full flex items-center gap-2.5 p-2 rounded-xl transition-all text-left hover:bg-secondary/60",
                conv.unread_count > 0 && "bg-primary/5"
              )}
            >
              <div className="relative flex-shrink-0">
                <UserAvatar src={conv.participant.avatar_url} alt={conv.participant.name} size="md" />
                <div className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-background" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-1">
                  <span className={cn("text-xs truncate", conv.unread_count > 0 ? "font-bold" : "font-medium")}>
                    {conv.participant.name}
                  </span>
                  {conv.last_message && (
                    <span className="text-[9px] text-muted-foreground flex-shrink-0">
                      {formatMessageTime(conv.last_message.created_at)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <p className={cn("text-[11px] truncate flex-1", conv.unread_count > 0 ? "text-foreground font-medium" : "text-muted-foreground")}>
                    {conv.last_message?.body 
                      ? isCallMessage(conv.last_message.body) 
                        ? (getCallData(conv.last_message.body)?.status === 'missed' ? '📞 Appel manqué' : '📞 Appel terminé')
                        : isVoiceMessage(conv.last_message.body) ? '🎙️ Message vocal'
                        : isGifMessage(conv.last_message.body) ? '🎬 GIF'
                        : conv.last_message.body
                      : 'Démarrez la conversation…'}
                  </p>
                  {conv.unread_count > 0 && (
                    <span className="w-4 h-4 rounded-full bg-primary text-primary-foreground text-[8px] font-bold flex items-center justify-center flex-shrink-0">
                      {conv.unread_count > 9 ? '9+' : conv.unread_count}
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))
        )}
      </div>

      <NewConversationDialog open={showNewChat} onOpenChange={setShowNewChat} />
    </div>
  );
}

// ─── Chat View (inside widget) ───────────────────────────
function WidgetChatView({ conversationId }: { conversationId: string }) {
  const { user } = useAuth();
  const { data: conversations } = useConversations();
  const { data: messages, isLoading } = useMessages(conversationId);
  const sendMessage = useSendMessage();
  const deleteForMe = useDeleteMessageForMe();
  const deleteForEveryone = useDeleteMessageForEveryone();
  const markRead = useMarkConversationRead();
  const { data: hasPending } = useHasPendingMessages(conversationId);
  const acceptRequest = useAcceptMessageRequest();
  const rejectRequest = useRejectMessageRequest();
  const [newMessage, setNewMessage] = useState('');
  const [showEmojis, setShowEmojis] = useState(false);
  const [showGifs, setShowGifs] = useState(false);
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [deleteMenuMsgId, setDeleteMenuMsgId] = useState<string | null>(null);
  const [messageReactions, setMessageReactions] = useState<Record<string, string[]>>({});
  const [showAIMenu, setShowAIMenu] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { goBack, closeChat, minimizeChat, state: chatState } = useChatWidget();
  const conversation = conversations?.find(c => c.id === conversationId);
  const negotiationProduct = chatState.negotiationProduct;

  // Negotiation hooks
  const { data: negotiations = [] } = useNegotiations(negotiationProduct?.id);
  const createNeg = useCreateNegotiation();
  const respondNeg = useRespondNegotiation();
  const acceptCounter = useAcceptCounterOffer();
  const [showOfferInput, setShowOfferInput] = useState(false);
  const [offerPrice, setOfferPrice] = useState('');
  const [counterInput, setCounterInput] = useState('');
  const [counterNegId, setCounterNegId] = useState<string | null>(null);

  const seller = negotiationProduct?.seller_profiles;
  const isSeller = seller && (seller as any).user_id === user?.id;

  const myNegotiation = useMemo(() =>
    negotiations.find(n => n.buyer_id === user?.id && ['pending', 'counter'].includes(n.status)),
    [negotiations, user]
  );
  const acceptedNeg = useMemo(() =>
    negotiations.find(n => n.buyer_id === user?.id && n.status === 'accepted'),
    [negotiations, user]
  );
  const pendingForSeller = useMemo(() =>
    negotiations.filter(n => n.status === 'pending' || n.status === 'counter'),
    [negotiations]
  );

  const handleMakeOffer = async () => {
    const price = parseFloat(offerPrice);
    if (!negotiationProduct || !seller) return;
    if (isNaN(price) || price <= 0) { toast.error('Prix invalide'); return; }
    if (price >= negotiationProduct.price) { toast.error('Votre offre doit être inférieure au prix'); return; }
    createNeg.mutate({
      productId: negotiationProduct.id,
      sellerProfileId: seller.id,
      originalPrice: negotiationProduct.price,
      offeredPrice: price,
      conversationId,
    }, {
      onSuccess: () => {
        setShowOfferInput(false);
        setOfferPrice('');
        sendMessage.mutate({ conversationId, body: `💰 OFFRE: ${price.toFixed(2)} € pour "${negotiationProduct.title}" (prix: ${negotiationProduct.price.toFixed(2)} €)` });
      },
    });
  };

  const handleSellerRespond = (neg: Negotiation, action: 'accepted' | 'rejected') => {
    respondNeg.mutate({ negotiationId: neg.id, action }, {
      onSuccess: () => {
        const msg = action === 'accepted'
          ? `✅ OFFRE ACCEPTÉE: ${neg.offered_price.toFixed(2)} € pour "${negotiationProduct?.title}"`
          : `❌ OFFRE REFUSÉE pour "${negotiationProduct?.title}"`;
        sendMessage.mutate({ conversationId, body: msg });
      },
    });
  };

  const handleCounterOffer = (neg: Negotiation, counterPrice: number) => {
    respondNeg.mutate({ negotiationId: neg.id, action: 'counter', counterPrice }, {
      onSuccess: () => {
        sendMessage.mutate({ conversationId, body: `🔄 CONTRE-OFFRE: ${counterPrice.toFixed(2)} € pour "${negotiationProduct?.title}"` });
      },
    });
  };

  const handlePayNegotiated = async () => {
    if (!acceptedNeg) return;
    try {
      const { data, error } = await supabase.functions.invoke('marketplace-checkout', {
        body: { action: 'negotiation_checkout', negotiationId: acceptedNeg.id },
      });
      if (error || data?.error) throw new Error(data?.error || 'Erreur');
      if (data?.url) window.location.href = data.url;
    } catch (e: any) { toast.error(e.message || 'Erreur paiement'); }
  };

  // Call hook & sound
  const [showVoicemailPrompt, setShowVoicemailPrompt] = useState(false);
  const call = useCall({
    onCallEnded: useCallback((info: CallEndInfo) => {
      // Send a system message about the call
      const callMsg = info.wasMissed
        ? `📞 CALL:missed|${info.type}`
        : `📞 CALL:ended|${info.type}|dur:${info.duration}`;
      sendMessage.mutate({ conversationId, body: callMsg });

      // If the call was missed, offer voicemail
      if (info.wasMissed) {
        setShowVoicemailPrompt(true);
      }
    }, [conversationId]),
  });
  const playSound = useRealtimeNotificationSound();
  const prevMsgCountRef = useRef(0);

  // Play sound on new incoming message
  useEffect(() => {
    if (!messages?.length) return;
    if (prevMsgCountRef.current > 0 && messages.length > prevMsgCountRef.current) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.sender_id !== user?.id) {
        playSound('message');
      }
    }
    prevMsgCountRef.current = messages.length;
  }, [messages?.length]);

  const { upload, isUploading } = useImageUpload({
    bucket: 'post-images',
    onSuccess: (url) => {
      sendMessage.mutate({ conversationId, body: '📷 Photo', imageUrl: url });
    },
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (conversationId) markRead.mutate(conversationId);
  }, [conversationId]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim()) return;
    const body = replyTo
      ? `↩️ ${replyTo.profile.name}: \"${replyTo.body.slice(0, 40)}…\"\n\n${newMessage.trim()}`
      : newMessage.trim();
    sendMessage.mutate({ conversationId, body }, {
      onSuccess: () => {
        setNewMessage('');
        setReplyTo(null);
        setShowEmojis(false);
        inputRef.current?.focus();
      },
    });
  };

  const handleAI = async (action: 'correct' | 'improve' | 'translate', tone?: string) => {
    if (!newMessage.trim() || aiLoading) return;
    setAiLoading(true);
    setShowAIMenu(false);
    const start = performance.now();
    try {
      const reqBody: Record<string, string> = { action, text: newMessage.trim() };
      if (action === 'translate') reqBody.targetLanguage = 'en';
      if (tone) reqBody.tone = tone;
      const { data, error } = await supabase.functions.invoke('ai-content', { body: reqBody });
      trackAICall(`chat-${action}`, Math.round(performance.now() - start), !error && !data?.error);
      if (error || data?.error) { toast.error(data?.error || 'Erreur IA'); return; }
      if (data?.result) setAiSuggestion(data.result);
    } catch { toast.error('Erreur IA'); } finally { setAiLoading(false); }
  };

  const handleReact = (msgId: string, emoji: string) => {
    setMessageReactions(prev => {
      const existing = prev[msgId] || [];
      if (existing.includes(emoji)) return { ...prev, [msgId]: existing.filter(e => e !== emoji) };
      return { ...prev, [msgId]: [...existing, emoji] };
    });
    setActiveMessageId(null);
  };

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
    <div className="flex flex-col h-full">
      {/* Call overlay */}
      <CallOverlay
        callState={call.callState}
        callType={call.callType}
        isMuted={call.isMuted}
        isCameraOff={call.isCameraOff}
        duration={call.duration}
        participantName={conversation?.participant.name || ''}
        participantAvatar={conversation?.participant.avatar_url}
        localVideoRef={call.localVideoRef}
        remoteVideoRef={call.remoteVideoRef}
        onEndCall={call.endCall}
        onToggleMute={call.toggleMute}
        onToggleCamera={call.toggleCamera}
        onSwitchToVideo={call.switchToVideo}
        onSwitchCamera={call.switchCamera}
      />
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) upload(file);
        e.target.value = '';
      }} />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30 bg-primary text-primary-foreground rounded-t-lg">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {conversation && (
            <>
              <div className="relative flex-shrink-0">
                <UserAvatar src={conversation.participant.avatar_url} alt={conversation.participant.name} size="sm" />
                <div className="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-emerald-400 border border-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold truncate">{conversation.participant.name}</p>
                <p className="text-[9px] opacity-80 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  En ligne
                </p>
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-0">
          <button onClick={() => call.startCall(conversationId, 'audio')} className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-primary-foreground/20 transition-colors">
            <Phone className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => call.startCall(conversationId, 'video')} className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-primary-foreground/20 transition-colors">
            <Video className="w-3.5 h-3.5" />
          </button>
          <button onClick={minimizeChat} className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-primary-foreground/20 transition-colors">
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button onClick={closeChat} className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-primary-foreground/20 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Pending message request banner */}
      {hasPending && (
        <div className="mx-2 mt-2 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2.5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1">📩 Demande de message</p>
          <p className="text-[10px] text-muted-foreground mb-2">Cette personne ne fait pas partie de vos amis. Voulez-vous accepter ses messages ?</p>
          <div className="flex gap-2">
            <button
              onClick={() => acceptRequest.mutate(conversationId)}
              disabled={acceptRequest.isPending}
              className="px-3 py-1 rounded-full bg-primary text-primary-foreground text-[10px] font-medium hover:bg-primary/90 transition-colors"
            >
              ✅ Accepter
            </button>
            <button
              onClick={() => rejectRequest.mutate(conversationId)}
              disabled={rejectRequest.isPending}
              className="px-3 py-1 rounded-full bg-destructive/10 text-destructive text-[10px] font-medium hover:bg-destructive/20 transition-colors"
            >
              🚫 Refuser
            </button>
          </div>
        </div>
      )}

      {/* Negotiation product banner */}
      {negotiationProduct && (
        <div className="mx-2 mt-2 bg-primary/5 border border-primary/20 rounded-xl px-3 py-2">
          <div className="flex items-center gap-2">
            {negotiationProduct.thumbnail_url && (
              <img src={negotiationProduct.thumbnail_url} className="w-10 h-10 rounded-lg object-cover" alt="" />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold truncate">{negotiationProduct.title}</p>
              <p className="text-[10px] text-muted-foreground">{seller?.store_name} · {negotiationProduct.price.toFixed(2)} €</p>
            </div>
            {!isSeller && !myNegotiation && !acceptedNeg && (
              <Button size="sm" className="h-7 text-[10px] rounded-xl gap-1" onClick={() => setShowOfferInput(true)}>
                <Tag className="w-3 h-3" /> Offrir
              </Button>
            )}
          </div>

          {/* Offer input */}
          {showOfferInput && (
            <div className="flex gap-1.5 mt-2">
              <Input
                type="number" step="0.01" min="0"
                value={offerPrice}
                onChange={e => setOfferPrice(e.target.value)}
                placeholder={`Max ${negotiationProduct.price.toFixed(2)} €`}
                className="h-7 text-xs rounded-lg flex-1"
              />
              <Button size="sm" className="h-7 text-[10px] rounded-lg" onClick={handleMakeOffer} disabled={createNeg.isPending}>
                Envoyer
              </Button>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 rounded-lg" onClick={() => setShowOfferInput(false)}>
                <X className="w-3 h-3" />
              </Button>
            </div>
          )}

          {/* Buyer: pending offer */}
          {myNegotiation && !isSeller && (
            <div className="mt-2 text-[10px]">
              {myNegotiation.status === 'pending' && (
                <p className="text-muted-foreground">⏳ Votre offre de <b className="text-foreground">{myNegotiation.offered_price.toFixed(2)} €</b> est en attente</p>
              )}
              {myNegotiation.status === 'counter' && (
                <div className="space-y-1.5">
                  <p>🔄 Contre-offre du vendeur: <b className="text-foreground">{myNegotiation.counter_price?.toFixed(2)} €</b></p>
                  <div className="flex gap-1">
                    <Button size="sm" className="h-6 text-[10px] rounded-full px-2.5"
                      onClick={() => acceptCounter.mutate({ negotiationId: myNegotiation.id }, {
                        onSuccess: () => sendMessage.mutate({ conversationId, body: `✅ CONTRE-OFFRE ACCEPTÉE: ${myNegotiation.counter_price?.toFixed(2)} €` })
                      })}>
                      <Check className="w-3 h-3 mr-0.5" /> Accepter
                    </Button>
                    <Button size="sm" variant="outline" className="h-6 text-[10px] rounded-full px-2.5"
                      onClick={() => respondNeg.mutate({ negotiationId: myNegotiation.id, action: 'rejected' })}>
                      <XIcon className="w-3 h-3 mr-0.5" /> Refuser
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Buyer: accepted - pay button */}
          {acceptedNeg && !isSeller && (
            <div className="mt-2 flex items-center gap-2">
              <Check className="w-3.5 h-3.5 text-emerald-600" />
              <span className="text-[10px] font-semibold text-emerald-700 flex-1">
                Prix négocié: <b>{(acceptedNeg.counter_price || acceptedNeg.offered_price).toFixed(2)} €</b>
              </span>
              <Button size="sm" className="h-7 rounded-xl text-[10px] gap-1 premium-button" onClick={handlePayNegotiated}>
                <CreditCard className="w-3 h-3" /> Payer
              </Button>
            </div>
          )}

          {/* Seller: pending offers to respond */}
          {isSeller && pendingForSeller.map(neg => (
            <div key={neg.id} className="mt-2 bg-amber-500/10 rounded-lg p-2 text-[10px]">
              <p className="font-semibold mb-1">
                {neg.status === 'pending'
                  ? `💰 Offre: ${neg.offered_price.toFixed(2)} € (prix: ${neg.original_price.toFixed(2)} €)`
                  : `🔄 Attente réponse à votre contre-offre de ${neg.counter_price?.toFixed(2)} €`}
              </p>
              {neg.status === 'pending' && (
                <>
                  <div className="flex gap-1">
                    <Button size="sm" className="h-6 text-[10px] rounded-full px-2" onClick={() => handleSellerRespond(neg, 'accepted')}>
                      <Check className="w-3 h-3 mr-0.5" /> Accepter
                    </Button>
                    <Button size="sm" variant="outline" className="h-6 text-[10px] rounded-full px-2" onClick={() => setCounterNegId(neg.id)}>
                      <ArrowRightLeft className="w-3 h-3 mr-0.5" /> Contre-offre
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 text-[10px] rounded-full px-2 text-destructive" onClick={() => handleSellerRespond(neg, 'rejected')}>
                      <XIcon className="w-3 h-3" />
                    </Button>
                  </div>
                  {counterNegId === neg.id && (
                    <div className="flex gap-1 mt-1.5">
                      <Input type="number" step="0.01" min="0" value={counterInput} onChange={e => setCounterInput(e.target.value)}
                        placeholder="Votre prix" className="h-6 text-[10px] rounded-lg flex-1" />
                      <Button size="sm" className="h-6 text-[10px] rounded-lg" onClick={() => {
                        const p = parseFloat(counterInput);
                        if (isNaN(p) || p <= 0) return;
                        handleCounterOffer(neg, p);
                        setCounterNegId(null);
                        setCounterInput('');
                      }}>OK</Button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto overflow-x-visible px-3 py-2 space-y-0.5 relative">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          </div>
        ) : messages?.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Send className="w-5 h-5 text-primary" />
            </div>
            <p className="text-xs text-muted-foreground">Dites bonjour ! 👋</p>
            <div className="flex flex-wrap gap-1.5 justify-center">
              {['Salut ! 👋', 'Ça va ? 😊', 'Hey ! ✨'].map(s => (
                <button
                  key={s}
                  onClick={() => sendMessage.mutate({ conversationId, body: s })}
                  className="px-3 py-1 rounded-full bg-primary/10 text-primary text-[10px] font-medium hover:bg-primary/20 transition-all"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          groupedMessages.map((group, gi) => (
            <div key={gi}>
              <div className="flex items-center justify-center my-3">
                <span className="text-[9px] font-medium text-muted-foreground bg-secondary/60 px-3 py-0.5 rounded-full capitalize">
                  {formatDateSeparator(group.date)}
                </span>
              </div>
              <div className="space-y-0.5">
                {group.messages.map((msg, mi) => {
                  const isMe = msg.sender_id === user?.id;
                  const prevMsg = mi > 0 ? group.messages[mi - 1] : null;
                  const nextMsg = mi < group.messages.length - 1 ? group.messages[mi + 1] : null;
                  const isFirstInGroup = !prevMsg || prevMsg.sender_id !== msg.sender_id;
                  const isLastInGroup = !nextMsg || nextMsg.sender_id !== msg.sender_id;
                  const reactions = messageReactions[msg.id] || [];
                   const isBigEmoji = isSingleEmoji(msg.body);
                   const isNegotiationMsg = msg.body.startsWith('💰 OFFRE:') || msg.body.startsWith('✅ OFFRE') || msg.body.startsWith('❌ OFFRE') || msg.body.startsWith('🔄 CONTRE') || msg.body.startsWith('✅ CONTRE');

                  return (
                    <div
                      key={msg.id}
                      className={cn('flex gap-1.5 relative group', isMe ? 'flex-row-reverse' : '', isFirstInGroup ? 'mt-2' : 'mt-0.5')}
                    >
                      {!isMe && (
                        <div className="w-6 flex-shrink-0">
                          {isLastInGroup && <UserAvatar src={msg.profile.avatar_url} alt={msg.profile.name} size="xs" />}
                        </div>
                      )}
                      <div className={cn('max-w-[80%] flex flex-col', isMe ? 'items-end' : 'items-start')}>
                        {/* Reactions on hover */}
                        {activeMessageId === msg.id && !deleteMenuMsgId && (
                          <>
                            <div className="fixed inset-0 z-50" onClick={() => setActiveMessageId(null)} />
                            <div className={cn("absolute z-50 flex items-center gap-0 px-1 py-0.5 rounded-full bg-background shadow-lg border border-border/40", isMe ? "right-0 -top-8" : "left-6 -top-8")}>
                              {MESSAGE_REACTIONS.map(r => (
                                <button key={r.label} onClick={() => handleReact(msg.id, r.emoji)} className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-secondary hover:scale-125 transition-all text-sm">
                                  {r.emoji}
                                </button>
                              ))}
                              <button onClick={() => { setReplyTo(msg); setActiveMessageId(null); }} className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-secondary transition-all">
                                <Reply className="w-3 h-3 text-muted-foreground" />
                              </button>
                              <button onClick={() => { setDeleteMenuMsgId(msg.id); setActiveMessageId(null); }} className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-destructive/10 transition-all">
                                <Trash2 className="w-3 h-3 text-destructive" />
                              </button>
                            </div>
                          </>
                        )}

                        {/* Premium Delete Dialog */}
                        {deleteMenuMsgId === msg.id && (
                          <>
                            <div className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm" onClick={() => setDeleteMenuMsgId(null)} />
                            <div className="fixed z-[101] w-[260px] rounded-2xl bg-background shadow-2xl border border-border/30 overflow-hidden"
                              style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
                            >
                              {/* Preview of the message */}
                              <div className="px-4 pt-4 pb-3 bg-secondary/30">
                                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Message sélectionné</p>
                                <div className={cn(
                                  'px-3 py-2 rounded-xl text-xs max-w-full truncate',
                                  isMe ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                                )}>
                                  {isCallMessage(msg.body) ? '📞 Appel' :
                                   isVoiceMessage(msg.body) ? '🎙️ Message vocal' : 
                                   isGifMessage(msg.body) ? '🎬 GIF' : 
                                   msg.body.length > 50 ? msg.body.slice(0, 50) + '…' : msg.body}
                                </div>
                              </div>
                              <div className="p-2 space-y-0.5">
                                <button
                                  onClick={() => {
                                    deleteForMe.mutate({ messageId: msg.id, conversationId });
                                    setDeleteMenuMsgId(null);
                                  }}
                                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs hover:bg-secondary transition-all text-left group/btn"
                                >
                                  <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center group-hover/btn:bg-muted-foreground/10 transition-colors">
                                    <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                                  </div>
                                  <div>
                                    <p className="font-medium">Supprimer pour moi</p>
                                    <p className="text-[10px] text-muted-foreground">Ce message disparaîtra de votre vue</p>
                                  </div>
                                </button>
                                {isMe && (
                                  <button
                                    onClick={() => {
                                      deleteForEveryone.mutate({ messageId: msg.id, conversationId });
                                      setDeleteMenuMsgId(null);
                                    }}
                                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs hover:bg-destructive/5 transition-all text-left group/btn"
                                  >
                                    <div className="w-8 h-8 rounded-full bg-destructive/10 flex items-center justify-center group-hover/btn:bg-destructive/20 transition-colors">
                                      <Trash2 className="w-3.5 h-3.5 text-destructive" />
                                    </div>
                                    <div>
                                      <p className="font-medium text-destructive">Supprimer pour tous</p>
                                      <p className="text-[10px] text-muted-foreground">Plus personne ne verra ce message</p>
                                    </div>
                                  </button>
                                )}
                                {!isMe && (
                                  <button
                                    onClick={async () => {
                                      await supabase.from('abuse_reports').insert({
                                        reporter_id: user!.id,
                                        reported_user_id: msg.sender_id,
                                        report_type: 'message',
                                        description: `Message signalé: "${msg.body.slice(0, 200)}"`,
                                      });
                                      setDeleteMenuMsgId(null);
                                      toast.success('Message signalé');
                                    }}
                                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs hover:bg-amber-500/5 transition-all text-left group/btn"
                                  >
                                    <div className="w-8 h-8 rounded-full bg-amber-500/10 flex items-center justify-center group-hover/btn:bg-amber-500/20 transition-colors">
                                      <Flag className="w-3.5 h-3.5 text-amber-600" />
                                    </div>
                                    <div>
                                      <p className="font-medium text-amber-600">Signaler</p>
                                      <p className="text-[10px] text-muted-foreground">Signaler ce contenu inapproprié</p>
                                    </div>
                                  </button>
                                )}
                              </div>
                              <div className="px-2 pb-2">
                                <button
                                  onClick={() => setDeleteMenuMsgId(null)}
                                  className="w-full py-2 rounded-xl text-xs font-medium text-muted-foreground hover:bg-secondary transition-all"
                                >
                                  Annuler
                                </button>
                              </div>
                            </div>
                          </>
                        )}

                        {msg.image_url && (
                          <div className="rounded-xl overflow-hidden mb-0.5 shadow-sm">
                            <img src={msg.image_url} alt="Photo" className="max-w-full max-h-[150px] object-cover" />
                          </div>
                        )}

                        {/* Call event message */}
                        {isCallMessage(msg.body) ? (() => {
                          const cd = getCallData(msg.body);
                          if (!cd) return null;
                          const isMissed = cd.status === 'missed';
                          return (
                            <div className="flex items-center justify-center w-full">
                              <div className={cn(
                                'flex items-center gap-2 px-3 py-2 rounded-2xl text-xs',
                                isMissed ? 'bg-destructive/10 text-destructive' : 'bg-secondary text-muted-foreground'
                              )}>
                                {isMissed ? (
                                  <PhoneMissed className="w-3.5 h-3.5" />
                                ) : (
                                  <Phone className="w-3.5 h-3.5" />
                                )}
                                <span className="font-medium">
                                  {isMissed
                                    ? `Appel ${cd.callType === 'video' ? 'vidéo' : 'audio'} manqué`
                                    : `Appel ${cd.callType === 'video' ? 'vidéo' : 'audio'} · ${formatCallDuration(cd.duration || 0)}`
                                  }
                                </span>
                              </div>
                            </div>
                          );
                        })()
                        /* GIF message */
                        : isGifMessage(msg.body) ? (
                          <div
                            onClick={() => setActiveMessageId(activeMessageId === msg.id ? null : msg.id)}
                            className="cursor-pointer rounded-xl overflow-hidden"
                          >
                            <img src={getGifUrl(msg.body)} alt="GIF" className="max-w-full max-h-[150px] object-cover rounded-xl" />
                          </div>
                        ) : isVoiceMessage(msg.body) ? (
                          <div onClick={() => setActiveMessageId(activeMessageId === msg.id ? null : msg.id)} className="cursor-pointer">
                            {(() => {
                              const vd = getVoiceData(msg.body);
                              return vd ? (
                                <VoiceMessagePlayer audioUrl={vd.url} duration={vd.duration} isMe={isMe} />
                              ) : (
                                <div className={cn('px-3 py-1.5 text-xs rounded-2xl', isMe ? 'bg-primary text-primary-foreground' : 'bg-secondary')}>
                                  🎙️ Message vocal
                                </div>
                              );
                            })()}
                          </div>
                        ) : isNegotiationMsg ? (
                          <div
                            onClick={() => setActiveMessageId(activeMessageId === msg.id ? null : msg.id)}
                            className="cursor-pointer select-none px-3 py-2 text-xs break-words leading-relaxed rounded-2xl bg-amber-500/10 border border-amber-500/30 text-foreground"
                          >
                            <MessageBodyWithLinks body={msg.body} isMe={false} />
                          </div>
                        ) : (
                          <div
                            onClick={() => setActiveMessageId(activeMessageId === msg.id ? null : msg.id)}
                            className={cn(
                              'cursor-pointer select-none transition-all',
                              isBigEmoji
                                ? 'text-2xl leading-none py-0.5'
                                : cn(
                                    'px-3 py-1.5 text-xs break-words leading-relaxed',
                                    isMe
                                      ? cn('bg-primary text-primary-foreground',
                                          isFirstInGroup && isLastInGroup && 'rounded-2xl rounded-br-md',
                                          isFirstInGroup && !isLastInGroup && 'rounded-2xl rounded-br-sm',
                                          !isFirstInGroup && isLastInGroup && 'rounded-2xl rounded-tr-sm rounded-br-md',
                                          !isFirstInGroup && !isLastInGroup && 'rounded-2xl rounded-tr-sm rounded-br-sm')
                                      : cn('bg-secondary',
                                          isFirstInGroup && isLastInGroup && 'rounded-2xl rounded-bl-md',
                                          isFirstInGroup && !isLastInGroup && 'rounded-2xl rounded-bl-sm',
                                          !isFirstInGroup && isLastInGroup && 'rounded-2xl rounded-tl-sm rounded-bl-md',
                                          !isFirstInGroup && !isLastInGroup && 'rounded-2xl rounded-tl-sm rounded-bl-sm')
                                  )
                            )}
                          >
                            <MessageBodyWithLinks body={msg.body} isMe={isMe} />
                          </div>
                        )}

                        {reactions.length > 0 && (
                          <div className={cn("flex items-center -mt-1 px-0.5", isMe ? "flex-row-reverse" : "")}>
                            <div className="flex items-center bg-background border border-border/40 rounded-full px-1 py-0 shadow-sm">
                              {reactions.map((r, i) => <span key={i} className="text-[10px]">{r}</span>)}
                            </div>
                          </div>
                        )}

                        {isLastInGroup && (
                          <div className={cn('flex items-center gap-0.5 mt-0.5 px-0.5', isMe ? 'flex-row-reverse' : '')}>
                            <span className="text-[8px] text-muted-foreground">{format(new Date(msg.created_at), 'HH:mm')}</span>
                            {isMe && <CheckCheck className="w-2.5 h-2.5 text-primary/60" />}
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

      {/* Reply preview */}
      {replyTo && (
        <div className="mx-2 mb-1 bg-secondary/80 rounded-lg px-3 py-1.5 flex items-center gap-2">
          <div className="w-0.5 h-6 rounded-full bg-primary flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[9px] font-semibold text-primary">{replyTo.sender_id === user?.id ? 'Vous' : replyTo.profile.name}</p>
            <p className="text-[10px] text-muted-foreground truncate">{replyTo.body}</p>
          </div>
          <button onClick={() => setReplyTo(null)}><X className="w-3 h-3 text-muted-foreground" /></button>
        </div>
      )}

      {/* Emoji picker */}
      {showEmojis && !showGifs && !showVoiceRecorder && (
        <div className="border-t border-border/20 bg-background">
          <div className="px-1.5 py-2 max-h-[130px] overflow-y-auto scrollbar-thin">
            {EMOJI_CATEGORIES.map((cat) => (
              <div key={cat.label} className="mb-1.5">
                <p className="text-[8px] font-semibold text-muted-foreground uppercase tracking-wider px-1.5 mb-1">{cat.label}</p>
                <div className="flex flex-wrap gap-0">
                  {cat.emojis.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => { setNewMessage(prev => prev + emoji); inputRef.current?.focus(); }}
                      className="w-7 h-7 flex items-center justify-center rounded hover:bg-secondary/80 active:scale-90 transition-all text-sm"
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

      {/* GIF picker */}
      {showGifs && !showVoiceRecorder && (
        <GifPicker
          onSelect={(gifUrl) => {
            sendMessage.mutate({ conversationId, body: `GIF:${gifUrl}` });
            setShowGifs(false);
          }}
          onClose={() => setShowGifs(false)}
        />
      )}

      {/* Voicemail prompt after missed call */}
      {showVoicemailPrompt && !showVoiceRecorder && (
        <div className="mx-2 mb-1 bg-destructive/5 border border-destructive/20 rounded-xl px-3 py-2 flex items-center gap-2">
          <PhoneMissed className="w-4 h-4 text-destructive flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-semibold text-destructive">Appel manqué</p>
            <p className="text-[9px] text-muted-foreground">Laisser un message vocal ?</p>
          </div>
          <button
            onClick={() => { setShowVoicemailPrompt(false); setShowVoiceRecorder(true); }}
            className="px-2.5 py-1 rounded-full bg-primary text-primary-foreground text-[10px] font-medium hover:bg-primary/90 transition-colors flex-shrink-0"
          >
            <Mic className="w-3 h-3 inline mr-1" />
            Vocal
          </button>
          <button onClick={() => setShowVoicemailPrompt(false)}>
            <X className="w-3 h-3 text-muted-foreground" />
          </button>
        </div>
      )}

      {/* Voice recorder */}
      {showVoiceRecorder && (
        <VoiceRecorder
          onSend={(audioUrl, duration) => {
            sendMessage.mutate({ conversationId, body: `🎙️ voice:${audioUrl}|dur:${duration}` });
            setShowVoiceRecorder(false);
            setShowVoicemailPrompt(false);
          }}
          onCancel={() => { setShowVoiceRecorder(false); }}
        />
      )}

      {/* AI suggestion preview */}
      {aiSuggestion && !showVoiceRecorder && (
        <div className="mx-2 mb-1 bg-primary/5 border border-primary/20 rounded-xl px-3 py-2">
          <div className="flex items-center gap-1.5 mb-1">
            <Wand2 className="w-3 h-3 text-primary" />
            <span className="text-[9px] font-semibold text-primary">Suggestion IA</span>
          </div>
          <p className="text-xs text-foreground leading-relaxed mb-2">{aiSuggestion}</p>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => { setNewMessage(aiSuggestion); setAiSuggestion(null); inputRef.current?.focus(); }}
              className="px-2.5 py-1 rounded-full bg-primary text-primary-foreground text-[10px] font-medium hover:bg-primary/90 transition-colors"
            >
              ✓ Utiliser
            </button>
            <button
              onClick={() => setAiSuggestion(null)}
              className="px-2.5 py-1 rounded-full bg-secondary text-secondary-foreground text-[10px] font-medium hover:bg-secondary/80 transition-colors"
            >
              ✗ Ignorer
            </button>
          </div>
        </div>
      )}

      {/* AI actions menu */}
      {showAIMenu && !showVoiceRecorder && (
        <div className="mx-2 mb-1 bg-background border border-border/40 rounded-xl shadow-lg overflow-hidden">
          <div className="p-1.5 grid grid-cols-2 gap-1">
            <button
              type="button"
              onClick={() => handleAI('correct')}
              disabled={!newMessage.trim()}
              className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg hover:bg-secondary/80 transition-colors text-left disabled:opacity-40"
            >
              <SpellCheck className="w-3.5 h-3.5 text-primary" />
              <div>
                <p className="text-[10px] font-semibold">Corriger</p>
                <p className="text-[8px] text-muted-foreground">Orthographe & grammaire</p>
              </div>
            </button>
            <button
              type="button"
              onClick={() => handleAI('improve', 'friendly')}
              disabled={!newMessage.trim()}
              className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg hover:bg-secondary/80 transition-colors text-left disabled:opacity-40"
            >
              <PenLine className="w-3.5 h-3.5 text-primary" />
              <div>
                <p className="text-[10px] font-semibold">Améliorer</p>
                <p className="text-[8px] text-muted-foreground">Style & ton</p>
              </div>
            </button>
            <button
              type="button"
              onClick={() => handleAI('translate')}
              disabled={!newMessage.trim()}
              className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg hover:bg-secondary/80 transition-colors text-left disabled:opacity-40"
            >
              <Languages className="w-3.5 h-3.5 text-primary" />
              <div>
                <p className="text-[10px] font-semibold">Traduire</p>
                <p className="text-[8px] text-muted-foreground">Anglais auto</p>
              </div>
            </button>
            <button
              type="button"
              onClick={() => handleAI('improve', 'formal')}
              disabled={!newMessage.trim()}
              className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg hover:bg-secondary/80 transition-colors text-left disabled:opacity-40"
            >
              <Sparkles className="w-3.5 h-3.5 text-primary" />
              <div>
                <p className="text-[10px] font-semibold">Formel</p>
                <p className="text-[8px] text-muted-foreground">Ton pro</p>
              </div>
            </button>
          </div>
        </div>
      )}

      {/* Input bar */}
      {!showVoiceRecorder && (
        <div className="border-t border-border/30 bg-background">
          <form onSubmit={handleSend} className="flex items-center gap-1 px-2 py-1.5">
            <div className="flex items-center gap-0">
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isUploading} className="w-7 h-7 rounded-full flex items-center justify-center text-muted-foreground hover:text-primary transition-colors">
                {isUploading ? <div className="w-3.5 h-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin" /> : <Camera className="w-4 h-4" />}
              </button>
              <button type="button" onClick={() => { setShowGifs(v => !v); setShowEmojis(false); }} className={cn("w-7 h-7 rounded-full flex items-center justify-center transition-colors text-[11px] font-bold", showGifs ? "text-primary" : "text-muted-foreground hover:text-primary")}>
                GIF
              </button>
              <button type="button" onClick={() => { setShowEmojis(v => !v); setShowGifs(false); setShowAIMenu(false); }} className={cn("w-7 h-7 rounded-full flex items-center justify-center transition-colors", showEmojis ? "text-primary" : "text-muted-foreground hover:text-primary")}>
                <Smile className="w-4 h-4" />
              </button>
              <button type="button" onClick={() => { setShowAIMenu(v => !v); setShowEmojis(false); setShowGifs(false); }} className={cn("w-7 h-7 rounded-full flex items-center justify-center transition-colors", showAIMenu ? "text-primary" : "text-muted-foreground hover:text-primary")}>
                {aiLoading ? <div className="w-3.5 h-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin" /> : <Wand2 className="w-4 h-4" />}
              </button>
            </div>

            <input
              ref={inputRef}
              value={newMessage}
              onChange={e => setNewMessage(e.target.value)}
              onFocus={() => { setShowEmojis(false); setShowGifs(false); }}
              placeholder="Aa"
              className="flex-1 bg-secondary/60 rounded-full px-3 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:bg-secondary transition-colors min-w-0"
            />

            {newMessage.trim() ? (
              <button type="submit" disabled={sendMessage.isPending} className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center flex-shrink-0 hover:bg-primary/90 transition-colors">
                <Send className="w-3.5 h-3.5" />
              </button>
            ) : (
              <div className="flex items-center gap-0">
                <button
                  type="button"
                  onClick={() => setShowVoiceRecorder(true)}
                  className="w-7 h-7 rounded-full flex items-center justify-center text-muted-foreground hover:text-primary transition-colors"
                >
                  <Mic className="w-4 h-4" />
                </button>
                <button type="button" className="w-7 h-7 rounded-full flex items-center justify-center text-primary flex-shrink-0 hover:bg-primary/10 transition-colors">
                  <ThumbsUp className="w-4 h-4" fill="currentColor" />
                </button>
              </div>
            )}
          </form>
        </div>
      )}
    </div>
  );
}

// ─── Main Widget ─────────────────────────────────────────
export function ChatWidget() {
  const { user } = useAuth();
  const { state, restoreChat, closeChat } = useChatWidget();

  if (!user || !state.isOpen) return null;

  // Minimized state - show a small bubble
  if (state.isMinimized) {
    return (
      <button
        onClick={restoreChat}
        className="fixed bottom-0 right-[90px] z-[60] w-12 h-12 rounded-t-lg bg-primary text-primary-foreground shadow-lg flex items-center justify-center hover:scale-105 active:scale-95 transition-all animate-in zoom-in-75"
      >
        <Send className="w-5 h-5" />
      </button>
    );
  }

  return (
    <div className="fixed bottom-0 right-[80px] z-[60] w-[328px] h-[455px] bg-background border border-border/40 rounded-t-lg shadow-2xl shadow-black/20 flex flex-col animate-in slide-in-from-bottom-4 duration-200 overflow-hidden">
      {state.conversationId ? (
        <WidgetChatView conversationId={state.conversationId} />
      ) : (
        <WidgetConversationList />
      )}
    </div>
  );
}
