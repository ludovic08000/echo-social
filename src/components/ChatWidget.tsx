import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Send, Search, Plus, X, Phone, Video, Mic, MicOff,
  Smile, Check, CheckCheck, Minus, Camera, Reply, Copy, Trash2,
  ChevronDown, Sparkles, MoreVertical, ThumbsUp, ImageIcon, PhoneOff, PhoneMissed,
  Flag, Forward, Wand2, Languages, SpellCheck, PenLine, Tag, ArrowRightLeft, CreditCard, XIcon, MapPin, Truck, Maximize2, Users
} from 'lucide-react';
import { AddParticipantSheet } from '@/components/calls/AddParticipantSheet';
import { formatDistanceToNow, format, isToday, isYesterday, isSameDay } from 'date-fns';
import { fr } from 'date-fns/locale';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConversations, useMessages, useSendMessage, useMarkConversationRead, useCreateConversation, useDeleteMessageForMe, useDeleteMessageForEveryone, useHasPendingMessages, useAcceptMessageRequest, useRejectMessageRequest, type Message } from '@/hooks/useMessages';
import { useNegotiations, useCreateNegotiation, useRespondNegotiation, useAcceptCounterOffer, useNegotiationsByConversation, type Negotiation } from '@/hooks/useNegotiations';
import { useFriendships } from '@/hooks/useFriendships';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { trackAICall } from '@/lib/aiEngine';
import { cn } from '@/lib/utils';
import { useChatWidget } from './ChatWidgetContext';
import { useImageUpload } from '@/hooks/useImageUpload';
import { generateMediaKey, encryptMedia, buildMediaMessageBody, parseMediaMessage, isVideoMediaLabel } from '@/lib/crypto/mediaEncrypt';
import { logCryptoException, logCryptoError } from '@/lib/crypto/errorLogger';
import { MessageMedia } from '@/components/messages/MessageMedia';
import { EncryptedMedia } from '@/components/messages/EncryptedMedia';
import { useCall, formatCallDuration, type CallEndInfo, generateCallE2EEKey } from '@/hooks/useCall';
import { CallOverlay } from '@/components/CallOverlay';
import { signalOutgoingCall, endActiveCall } from '@/hooks/useIncomingCall';
import { GifPicker } from '@/components/chat/GifPicker';
import { VoiceRecorder, VoiceMessagePlayer } from '@/components/chat/VoiceRecorder';
import { buildDocumentBody, parseDocumentBody, isDocumentMime } from '@/lib/messaging/documentMessage';
import { DocumentBubble } from '@/components/messages/DocumentBubble';
import { CallHistoryPanel } from '@/components/calls/CallHistoryPanel';
import { Eye } from 'lucide-react';
import { RelayPointPicker } from '@/components/marketplace/RelayPointPicker';
import { useRealtimeNotificationSound } from '@/hooks/useNotificationSounds';
import { toast } from 'sonner';
import { useMessageTranslation } from '@/hooks/useMessageTranslation';
import { useE2EE } from '@/hooks/useE2EE';
import { useMessageQueue } from '@/hooks/useMessageQueue';
import { DecryptedMessageBody } from '@/components/messages/DecryptedMessageBody';
import { EncryptionBadge, EncryptionStatusBar } from '@/components/messages/EncryptionBadge';
import { OutboundStatusIndicator } from '@/components/messages/OutboundStatus';
import { ConversationPreviewText } from '@/components/messages/ConversationPreviewText';
import { savePlaintext, loadPlaintext } from '@/lib/crypto/plaintextStore';
import { MessagingPinGate } from '@/components/MessagingPinGate';
import { useMessageReactions } from '@/hooks/useMessageReactions';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

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
            href={sanitizeUrl(part)}
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
  return body.startsWith('🎙️ ') && (body.includes('voice:') || body.includes('vocal:'));
}

function getVoiceData(body: string): { url: string; duration: number } | null {
  // Format: 🎙️ vocal:URL|duration  or  🎙️ voice:URL|duration
  const m1 = body.match(/(?:vocal|voice):(.*?)\|(\d+)$/);
  if (m1) return { url: m1[1], duration: parseInt(m1[2], 10) };
  // Format: 🎙️ voice:URL|dur:duration
  const m2 = body.match(/(?:vocal|voice):(.*?)\|dur:(\d+)$/);
  if (m2) return { url: m2[1], duration: parseInt(m2[2], 10) };
  return null;
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
                    <ConversationPreviewText body={conv.last_message?.body} maxLength={50} />
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
  const navigate = useNavigate();
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
  const [viewOnceArmed, setViewOnceArmed] = useState(false);
  const [showCallHistory, setShowCallHistory] = useState(false);
  const [showGroupCallSheet, setShowGroupCallSheet] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [deleteMenuMsgId, setDeleteMenuMsgId] = useState<string | null>(null);
  // Persisted + realtime reactions (replaces local-only state)
  const [showAIMenu, setShowAIMenu] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [isSending] = useState(false);
  const { translations, translating, translate: translateMsg, autoTranslateMessages } = useMessageTranslation();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [isStartingCall, setIsStartingCall] = useState(false);
  const shouldAutoScrollRef = useRef(true);
  const lastScrollSigRef = useRef('');

  // Auto-translate non-French messages
  // Auto-translate disabled
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { goBack, closeChat, minimizeChat, state: chatState, openNegotiation: setNegotiationContext } = useChatWidget();
  const conversation = conversations?.find(c => c.id === conversationId);
  const peerUserId = conversation?.participant?.user_id;
  const isZeusConversation = peerUserId === '00000000-0000-0000-0000-000000000001';
  const negotiationProduct = chatState.negotiationProduct;

  // E2EE integration — STRICT: plaintext allowed only for the Zeus bot.
  const e2ee = useE2EE(conversationId, peerUserId);
  const isEncryptionActive = !isZeusConversation && e2ee.encrypted;
  const [cacheVersion, setCacheVersion] = useState(0);
  const bumpCache = useCallback(() => setCacheVersion(v => v + 1), []);
  const decryptRefreshKey = `${conversationId}:${e2ee.peerFingerprint ?? 'none'}:${Number(e2ee.encrypted)}:${cacheVersion}`;
  const stableBadgeRef = useRef({ encrypted: false, verified: false, ratchetActive: false });

  useEffect(() => {
    stableBadgeRef.current = { encrypted: false, verified: false, ratchetActive: false };
  }, [conversationId]);

  const stableBadgeState = useMemo(() => {
    if (e2ee.encrypted) {
      stableBadgeRef.current = {
        encrypted: true,
        verified: !e2ee.fingerprintChanged,
        ratchetActive: stableBadgeRef.current.ratchetActive || e2ee.ratchetActive,
      };
    } else if (e2ee.fingerprintChanged) {
      stableBadgeRef.current = {
        ...stableBadgeRef.current,
        verified: false,
      };
    }

    return stableBadgeRef.current;
  }, [conversationId, e2ee.encrypted, e2ee.fingerprintChanged, e2ee.ratchetActive]);

  const decryptedCacheRef = useRef<Map<string, string>>(new Map());
  const cachePlaintext = useCallback((msgId: string, text: string) => {
    decryptedCacheRef.current.set(msgId, text);
    bumpCache();
    void savePlaintext(msgId, text);
  }, [bumpCache]);

  // When E2EE keys are restored after login, drop empty/placeholder entries
  // and re-trigger decryption so previously-hidden messages re-appear in clear.
  useEffect(() => {
    const handler = () => {
      for (const [k, v] of decryptedCacheRef.current) {
        if (!v) decryptedCacheRef.current.delete(k);
      }
      bumpCache();
    };
    window.addEventListener('forsure-keys-restored', handler);
    return () => window.removeEventListener('forsure-keys-restored', handler);
  }, [bumpCache]);

  const queue = useMessageQueue(
    conversationId,
    e2ee.encrypt,
    e2ee.isReady(),
    isEncryptionActive,
    e2ee.acknowledgeSentPayload,
    isZeusConversation,
    cachePlaintext,
  );

  const onDecrypted = useCallback((msgId: string, text: string) => {
    const parsed = parseMediaMessage(text);
    cachePlaintext(msgId, parsed ? text : text);
  }, [cachePlaintext]);

  // Auto-load negotiation context from conversation if not set
  const { data: convNegotiations = [] } = useNegotiationsByConversation(!negotiationProduct ? conversationId : undefined);
  
  useEffect(() => {
    if (!negotiationProduct && convNegotiations.length > 0) {
      const neg = convNegotiations[0];
      if (neg.product) {
        setNegotiationContext({
          id: neg.product.id,
          title: neg.product.title,
          price: neg.product.price,
          thumbnail_url: neg.product.thumbnail_url,
          seller_profiles: neg.seller_profile,
        }, conversationId);
      }
    }
  }, [negotiationProduct, convNegotiations, conversationId, setNegotiationContext]);

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

  const [showRelayPicker, setShowRelayPicker] = useState(false);
  const [selectedRelay, setSelectedRelay] = useState<any>(null);
  const [negPayLoading, setNegPayLoading] = useState(false);

  const estimateShipping = (weightGrams: number) => {
    const base = 4.2;
    const extra = weightGrams <= 500 ? 0 : weightGrams <= 1000 ? 0.8 : weightGrams <= 2000 ? 1.6 : weightGrams <= 5000 ? 2.8 : 4.5;
    return Math.round((base + extra) * 100) / 100;
  };

  const handlePayNegotiated = async () => {
    if (!acceptedNeg) return;
    setNegPayLoading(true);
    try {
      const payload: any = { action: 'negotiation_checkout', negotiationId: acceptedNeg.id };
      if (selectedRelay) {
        payload.relay = selectedRelay;
      }
      const { data, error } = await supabase.functions.invoke('marketplace-checkout', { body: payload });
      if (error || data?.error) throw new Error(data?.error || 'Erreur');
      if (data?.url) window.location.href = data.url;
    } catch (e: any) { toast.error(e.message || 'Erreur paiement'); }
    finally { setNegPayLoading(false); }
  };

  // Call hook & sound
  const [showVoicemailPrompt, setShowVoicemailPrompt] = useState(false);
  const activeCallIdRef = useRef<string | null>(null);
  const call = useCall({
    onCallEnded: useCallback((info: CallEndInfo) => {
      // End the signaling record
      if (activeCallIdRef.current) {
        endActiveCall(activeCallIdRef.current);
        activeCallIdRef.current = null;
      }
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

  // Listen for callee declining/cancelling the call → auto-end on caller side
  useEffect(() => {
    const callId = activeCallIdRef.current;
    if (!callId || call.callState === 'idle') return;

    const channel = supabase
      .channel(`call-status-${callId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'active_calls',
          filter: `id=eq.${callId}`,
        },
        (payload) => {
          const updated = payload.new as any;
          if (updated.status === 'declined' || updated.status === 'cancelled' || updated.status === 'ended') {
            call.endCall();
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [call.callState]);

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

  const { upload: rawUpload, isUploading } = useImageUpload({
    bucket: 'post-images',
  });

  // Wrap upload: encrypt media before upload when E2EE is active
  const handleMediaFile = useCallback(async (file: File) => {
    if (!file || file.size === 0) {
      toast.error('Fichier invalide ou vide');
      return;
    }

    const isVideo = /\.(mp4|mov|webm|avi|mkv)$/i.test(file.name) || file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');
    const isDoc = !isImage && !isVideo && (isDocumentMime(file.type) || /\.(pdf|docx?|xlsx?|pptx?|zip|txt|csv)$/i.test(file.name));
    const armedVO = viewOnceArmed;
    setViewOnceArmed(false);

    // Documents path (PDF/Office/zip ≤100 Mo)
    if (isDoc) {
      if (file.size > 100 * 1024 * 1024) {
        toast.error('Document trop volumineux (max 100 Mo)');
        return;
      }
      if (!isZeusConversation && e2ee.peerKeyMissing) {
        toast.error('Clés du contact indisponibles.');
        return;
      }
      try {
        const { key, keyB64 } = await generateMediaKey();
        const encryptedBlob = await encryptMedia(file, key);
        const encFile = new File([encryptedBlob], `${file.name}.enc`, { type: 'application/octet-stream' });
        const url = await rawUpload(encFile);
        if (!url) { toast.error('Upload échoué'); return; }
        const body = buildDocumentBody(file.name, file.type || 'application/octet-stream', file.size, keyB64);
        queue.sendMessage(body, url, {
          view_once: armedVO,
          document_url: url,
          document_name: file.name,
          document_mime: file.type || 'application/octet-stream',
          document_size_bytes: file.size,
        }).catch((e) => {
          logCryptoException('media', e, { severity: 'error', conversationId, metadata: { stage: 'queue_send_doc' } });
          toast.error('Erreur envoi document');
        });
      } catch (err) {
        logCryptoException('media', err, { severity: 'error', conversationId, metadata: { stage: 'doc_encrypt_upload' } });
        toast.error('Erreur de chiffrement du document');
      }
      return;
    }

    const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
    const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
    if (!isVideo && file.size > MAX_PHOTO_BYTES) {
      toast.error(`Photo trop lourde (max ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} Mo)`);
      return;
    }
    if (isVideo && file.size > MAX_VIDEO_BYTES) {
      toast.error(`Vidéo trop lourde (max ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} Mo)`);
      return;
    }

    const label = isVideo ? '🎬 Vidéo' : '📷 Photo';

    let prepared: File = file;
    if (isVideo) {
      try {
        const { compressVideoForChat } = await import('@/lib/messaging/compressVideo');
        const result = await compressVideoForChat(file);
        prepared = result.compressed
          ? new File([result.blob], file.name.replace(/\.[^.]+$/, '.mp4'), { type: 'video/mp4' })
          : file;
      } catch {
        prepared = file;
      }
    }

    if (isZeusConversation) {
      try {
        const url = await rawUpload(prepared);
        if (!url) { toast.error("Échec de l'envoi : upload refusé"); return; }
        sendMessage.mutate({ conversationId, body: label, imageUrl: url });
      } catch (err) {
        toast.error(err instanceof Error ? `Erreur envoi : ${err.message}` : 'Erreur envoi');
      }
      return;
    }

    const t0 = performance.now();
    try {
      const { key, keyB64 } = await generateMediaKey();
      const encryptedBlob = await encryptMedia(prepared, key);
      const encFile = new File([encryptedBlob], `${prepared.name}.enc`, { type: 'application/octet-stream' });
      const url = await rawUpload(encFile);
      if (url) {
        const body = buildMediaMessageBody(label, keyB64);
        queue.sendMessage(body, url, { view_once: armedVO }).catch((e) => {
          logCryptoException('media', e, { severity: 'error', conversationId, metadata: { stage: 'queue_send', isVideo } });
          toast.error(e instanceof Error ? `Erreur envoi : ${e.message}` : 'Erreur envoi');
        });
        logCryptoError({
          severity: 'info', context: 'media', errorCode: 'MEDIA_ENCRYPT_OK',
          errorMessage: 'Media encrypted and uploaded',
          conversationId,
          metadata: { sizeBytes: prepared.size, mime: prepared.type, isVideo, viewOnce: armedVO, durationMs: Math.round(performance.now() - t0) },
        });
      } else {
        toast.error("Échec de l'envoi : upload refusé par le serveur");
      }
    } catch (err) {
      console.error('Media encryption failed:', err);
      logCryptoException('media', err, { severity: 'error', conversationId, metadata: { stage: 'encrypt_upload', sizeBytes: file.size, mime: file.type } });
      toast.error(err instanceof Error ? `Erreur : ${err.message}` : 'Erreur de chiffrement du média');
    }
  }, [isZeusConversation, rawUpload, conversationId, sendMessage, queue, e2ee.peerKeyMissing, viewOnceArmed]);

  useEffect(() => {
    lastScrollSigRef.current = '';
    shouldAutoScrollRef.current = true;
    setShowScrollDown(false);
  }, [conversationId]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
    shouldAutoScrollRef.current = true;
    setShowScrollDown(false);
  }, []);

  const handleMessagesScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < 80;
    setShowScrollDown(distanceFromBottom > 120);
  }, []);

  useEffect(() => {
    const lastMsg = messages?.length ? messages[messages.length - 1] : undefined;
    const lastPending = queue.pendingMessages.length
      ? queue.pendingMessages[queue.pendingMessages.length - 1]
      : undefined;
    const sig = `${messages?.length ?? 0}:${lastMsg?.id ?? ''}|${queue.pendingMessages.length}:${lastPending?.localId ?? ''}`;
    if (sig === lastScrollSigRef.current) return;

    const isInitialLoad = lastScrollSigRef.current === '';
    lastScrollSigRef.current = sig;

    if (isInitialLoad || shouldAutoScrollRef.current || lastMsg?.sender_id === user?.id || lastPending) {
      requestAnimationFrame(() => scrollToBottom(isInitialLoad ? 'auto' : 'smooth'));
    }
  }, [messages, queue.pendingMessages, scrollToBottom, user?.id]);

  useEffect(() => {
    if (!messages?.length) return;
    let cancelled = false;
    (async () => {
      let added = false;
      for (const msg of messages) {
        if (decryptedCacheRef.current.has(msg.id)) continue;
        const pt = await loadPlaintext(msg.id);
        if (cancelled) return;
        if (pt) {
          decryptedCacheRef.current.set(msg.id, pt);
          added = true;
        }
      }
      if (added && !cancelled) bumpCache();
    })();
    return () => { cancelled = true; };
  }, [messages, bumpCache]);

  useEffect(() => {
    if (conversationId) markRead.mutate(conversationId);
  }, [conversationId]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim()) return;

    // Show explicit reason if E2EE is not ready (especially on iOS Safari where
    // IndexedDB takes a moment to hydrate after login).
    if (sendBlocked) {
      if (e2ee.peerKeyMissing) {
        toast.error("Clés du contact indisponibles. Réessaie dans quelques secondes.");
      } else if (e2ee.initError === 'pin_unlock_required') {
        toast.error("Déverrouille d'abord la messagerie sécurisée (PIN).");
      } else if (e2ee.initError === 'identity_lost_backup_available') {
        toast.error("Restaure ton identité sécurisée avant d'envoyer.");
      } else {
        toast.error("Messagerie sécurisée pas encore prête, réessaie.");
      }
      console.warn('[ChatWidget] send blocked', {
        peerKeyMissing: e2ee.peerKeyMissing,
        initError: e2ee.initError,
      });
      return;
    }

    const replyText = replyTo ? decryptedCacheRef.current.get(replyTo.id) || replyTo.body : null;
    const body = replyTo
      ? `↩️ ${replyTo.profile.name}: "${(replyText || '').slice(0, 40)}…"\n\n${newMessage.trim()}`
      : newMessage.trim();

    // Clear input IMMEDIATELY for instant UX
    setNewMessage('');
    setReplyTo(null);
    setShowEmojis(false);
    shouldAutoScrollRef.current = true;
    inputRef.current?.focus();

    if (isZeusConversation) {
      sendMessage.mutate({ conversationId, body });
    } else {
      // Fire-and-forget: queue handles retry/encryption in background
      queue.sendMessage(body).catch(err => {
        toast.error(err instanceof Error ? err.message : 'Erreur envoi');
      });
    }
  };

  // Fingerprint change is no longer a blocker — only true unrecoverable states are.
  const sendBlocked = !isZeusConversation && (e2ee.peerKeyMissing || e2ee.initError === 'pin_unlock_required' || e2ee.initError === 'identity_lost_backup_available');

  const handleAI = async (action: 'correct' | 'improve' | 'translate', tone?: string) => {
    if (!newMessage.trim() || aiLoading) return;
    setAiLoading(true);
    setShowAIMenu(false);
    const start = performance.now();
    try {
      const reqBody: Record<string, string> = { action, text: newMessage.trim() };
      if (action === 'translate') reqBody.targetLanguage = 'en';
      if (tone) reqBody.tone = tone;
      const { data, error } = await supabase.functions.invoke('zeus', { body: { domain: 'content', ...reqBody } });
      trackAICall(`chat-${action}`, Math.round(performance.now() - start), !error && !data?.error);
      if (error || data?.error) { toast.error(data?.error || 'Erreur IA'); return; }
      if (data?.result) setAiSuggestion(data.result);
    } catch { toast.error('Erreur IA'); } finally { setAiLoading(false); }
  };

  const messageIds = useMemo(() => (messages || []).map(m => m.id), [messages]);
  const { reactions: reactionsByMessage, toggleReaction } = useMessageReactions(conversationId, messageIds);

  const handleReact = (msgId: string, emoji: string) => {
    void toggleReaction(msgId, emoji);
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
    <div className="relative flex flex-col h-full">
      {/* Call overlay */}
      <CallOverlay
        callState={call.callState}
        callType={call.callType}
        isMuted={call.isMuted}
        isCameraOff={call.isCameraOff}
        duration={call.duration}
        participantName={conversation?.participant.name || ''}
        participantAvatar={conversation?.participant.avatar_url}
        isE2eeActive={call.isE2eeActive}
        connectionQuality={call.connectionQuality}
        localVideoRef={call.localVideoRef}
        remoteVideoRef={call.remoteVideoRef}
        onEndCall={call.endCall}
        onToggleMute={call.toggleMute}
        onToggleCamera={call.toggleCamera}
        onSwitchToVideo={call.switchToVideo}
        onSwitchCamera={call.switchCamera}
        onToggleScreenShare={call.toggleScreenShare}
        isScreenSharing={call.isScreenSharing}
      />

      {/* Call history overlay */}
      {showCallHistory && (
        <div className="absolute inset-0 z-[90] bg-background/95 backdrop-blur-sm rounded-lg overflow-hidden">
          <CallHistoryPanel
            conversationId={conversationId}
            onClose={() => setShowCallHistory(false)}
            onCallBack={async (peerId, type) => {
              if (!user?.id) return;
              setShowCallHistory(false);
              setIsStartingCall(true);
              try {
                const callKey = generateCallE2EEKey();
                const callId = await signalOutgoingCall(conversationId, user.id, peerId, type, callKey);
                if (!callId) { toast.error("Impossible de signaler l'appel."); return; }
                activeCallIdRef.current = callId;
                await call.startCall(conversationId, type, callKey);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Appel impossible");
              } finally {
                setIsStartingCall(false);
              }
            }}
          />
        </div>
      )}

      {showGroupCallSheet && (
        <AddParticipantSheet
          open={showGroupCallSheet}
          onClose={() => setShowGroupCallSheet(false)}
          conversationId={conversationId}
          prefilled={conversation?.participant?.user_id ? [conversation.participant.user_id] : []}
          onCallStarted={async (_callId, _roomId, callKey, callType) => {
            try {
              await call.startCall(conversationId, callType, callKey);
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Impossible de rejoindre l'appel");
            }
          }}
        />
      )}

      <input ref={fileInputRef} type="file" accept="image/*,video/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/zip,text/plain,text/csv" className="hidden" onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) handleMediaFile(file);
        e.target.value = '';
      }} />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30 bg-primary text-primary-foreground rounded-t-lg">
        <button
          onClick={goBack}
          className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-primary-foreground/20 transition-colors flex-shrink-0"
          title="Retour aux conversations"
          aria-label="Retour aux conversations"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {conversation && (
            <>
              <Link to={`/profile/${conversation.participant.user_id}`} className="relative flex-shrink-0">
                <UserAvatar src={conversation.participant.avatar_url} alt={conversation.participant.name} size="sm" />
                <div className="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-emerald-400 border border-primary" />
              </Link>
              <Link to={`/profile/${conversation.participant.user_id}`} className="min-w-0">
                <div className="flex items-center gap-1 min-w-0">
                  <p className="text-xs font-semibold truncate hover:underline">{conversation.participant.name}</p>
                  {!isZeusConversation && stableBadgeState.encrypted && (
                    <EncryptionBadge
                      encrypted
                      verified={stableBadgeState.verified}
                      ratchetActive={stableBadgeState.ratchetActive}
                      size="xs"
                      showLabel
                      className="shrink-0 text-primary-foreground"
                    />
                  )}
                </div>
                <p className="text-[9px] opacity-80 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  En ligne
                </p>
              </Link>
            </>
          )}
        </div>
        <div className="flex items-center gap-0">
          <button
            disabled={isStartingCall}
            onClick={async () => {
              const participantId = conversation?.participant?.user_id;
              if (!participantId || !user?.id) {
                toast.error("Aucun contact à appeler dans cette conversation.");
                return;
              }
              setIsStartingCall(true);
              try {
                const callKey = generateCallE2EEKey();
                const callId = await signalOutgoingCall(conversationId, user.id, participantId, 'audio', callKey);
                if (!callId) {
                  toast.error("Impossible de signaler l'appel. Réessayez.");
                  return;
                }
                activeCallIdRef.current = callId;
                await call.startCall(conversationId, 'audio', callKey);
              } catch (err) {
                console.error('[ChatWidget] audio call failed', err);
                toast.error(err instanceof Error ? `Appel impossible : ${err.message}` : "Appel impossible");
              } finally {
                setIsStartingCall(false);
              }
            }}
            className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-primary-foreground/20 transition-colors disabled:opacity-50"
          >
            <Phone className={`w-3.5 h-3.5 ${isStartingCall ? 'animate-pulse' : ''}`} />
          </button>
          <button
            disabled={isStartingCall}
            onClick={async () => {
              const participantId = conversation?.participant?.user_id;
              if (!participantId || !user?.id) {
                toast.error("Aucun contact à appeler dans cette conversation.");
                return;
              }
              setIsStartingCall(true);
              try {
                const callKey = generateCallE2EEKey();
                const callId = await signalOutgoingCall(conversationId, user.id, participantId, 'video', callKey);
                if (!callId) {
                  toast.error("Impossible de signaler l'appel. Réessayez.");
                  return;
                }
                activeCallIdRef.current = callId;
                await call.startCall(conversationId, 'video', callKey);
              } catch (err) {
                console.error('[ChatWidget] video call failed', err);
                toast.error(err instanceof Error ? `Visio impossible : ${err.message}` : "Visio impossible");
              } finally {
                setIsStartingCall(false);
              }
            }}
            className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-primary-foreground/20 transition-colors disabled:opacity-50"
          >
            <Video className={`w-3.5 h-3.5 ${isStartingCall ? 'animate-pulse' : ''}`} />
          </button>
          <button
            onClick={() => setShowGroupCallSheet(true)}
            className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-primary-foreground/20 transition-colors"
            title="Appel de groupe"
          >
            <Users className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setShowCallHistory(true)}
            className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-primary-foreground/20 transition-colors"
            title="Historique d'appels"
          >
            <PhoneMissed className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => { closeChat(); navigate(`/messages/${conversationId}`); }} className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-primary-foreground/20 transition-colors" title="Agrandir">
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <button onClick={minimizeChat} className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-primary-foreground/20 transition-colors">
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button onClick={closeChat} className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-primary-foreground/20 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* E2EE Status */}
      {!isZeusConversation && (
        <EncryptionStatusBar
          encrypted={e2ee.encrypted}
          fingerprint={e2ee.fingerprint}
          peerFingerprint={e2ee.peerFingerprint}
          ratchetActive={e2ee.ratchetActive}
          fingerprintChanged={e2ee.fingerprintChanged}
          peerName={conversation?.participant?.name || 'Contact'}
          conversationId={conversationId || ''}
        />
      )}

      {/* Fingerprint change banner removed per user request — silent re-keying */}

      {/* Key recovery banners removed — restore happens silently in background
          via useAccountKeySync (auto-restore from password-derived backup),
          realtimeKeySync (peer key publish triggers messageQueue.resumeAll),
          and messageQueue (idempotent retry). The user only sees plaintext
          when keys arrive, never an instruction to "restore". The dedicated
          backup/restore UI lives in Settings → Privacy → Key Backup. */}

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

      <div
        ref={scrollContainerRef}
        onScroll={handleMessagesScroll}
        className="flex-1 overflow-y-auto overflow-x-visible px-3 py-2 space-y-0.5 relative"
      >
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
                  onClick={async () => {
                    if (isZeusConversation) {
                      sendMessage.mutate({ conversationId, body: s });
                    } else {
                      try { await queue.sendMessage(s); } catch { toast.error('Erreur envoi'); }
                    }
                  }}
                  className="px-3 py-1 rounded-full bg-primary/10 text-primary text-[10px] font-medium hover:bg-primary/20 transition-all"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {groupedMessages.map((group, gi) => (
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
                  const reactions = reactionsByMessage[msg.id] || [];
                   const isBigEmoji = isSingleEmoji(msg.body);
                   const isNegotiationMsg = msg.body.startsWith('💰 OFFRE:') || msg.body.startsWith('✅ OFFRE') || msg.body.startsWith('❌ OFFRE') || msg.body.startsWith('🔄 CONTRE') || msg.body.startsWith('✅ CONTRE');

                  return (
                    <div
                      key={msg.id}
                      className={cn('flex gap-1.5 relative group', isFirstInGroup ? 'mt-2' : 'mt-0.5')}
                    >
                      <div className="w-6 flex-shrink-0">
                        {isLastInGroup && <UserAvatar src={msg.profile.avatar_url} alt={msg.profile.name} size="xs" />}
                      </div>
                      <div className="max-w-[80%] flex flex-col items-start">
                        {/* Reactions on hover */}
                        {activeMessageId === msg.id && !deleteMenuMsgId && (
                          <>
                            <div className="fixed inset-0 z-50" onClick={() => setActiveMessageId(null)} />
                            <div className="absolute z-50 left-6 -top-8 flex items-center gap-0 px-1 py-0.5 rounded-full bg-background shadow-lg border border-border/40">
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

                        {(() => {
                          const docParsed = parseDocumentBody(msg.body);
                          if (docParsed && msg.image_url) {
                            return (
                              <DocumentBubble
                                encryptedUrl={msg.image_url}
                                doc={docParsed}
                                isMe={isMe}
                              />
                            );
                          }
                          return null;
                        })()}

                        {msg.image_url && !parseDocumentBody(msg.body) && (
                          <div className="rounded-xl overflow-hidden mb-0.5 shadow-sm">
                            <MessageMedia
                              imageUrl={msg.image_url}
                              body={msg.body}
                              decrypt={e2ee.decrypt}
                              isEncryptionActive={e2ee.encrypted && !isZeusConversation}
                              messageId={msg.id}
                            />
                          </div>
                        )}

                        {/* Skip text bubble when message is purely a media attachment */}
                        {msg.image_url && !isCallMessage(msg.body) ? null :
                        /* Call event message */
                        isCallMessage(msg.body) ? (() => {
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
                                          isFirstInGroup && isLastInGroup && 'rounded-2xl rounded-bl-md',
                                          isFirstInGroup && !isLastInGroup && 'rounded-2xl rounded-bl-sm',
                                          !isFirstInGroup && isLastInGroup && 'rounded-2xl rounded-tl-sm rounded-bl-md',
                                          !isFirstInGroup && !isLastInGroup && 'rounded-2xl rounded-tl-sm rounded-bl-sm')
                                      : cn('bg-secondary',
                                          isFirstInGroup && isLastInGroup && 'rounded-2xl rounded-bl-md',
                                          isFirstInGroup && !isLastInGroup && 'rounded-2xl rounded-bl-sm',
                                          !isFirstInGroup && isLastInGroup && 'rounded-2xl rounded-tl-sm rounded-bl-md',
                                          !isFirstInGroup && !isLastInGroup && 'rounded-2xl rounded-tl-sm rounded-bl-sm')
                                  )
                            )}
                          >
                            <DecryptedMessageBody
                              body={msg.body}
                              decrypt={e2ee.decrypt}
                              isEncryptionActive={isEncryptionActive}
                              onDecrypted={(text) => onDecrypted(msg.id, text)}
                              isMe={isMe}
                              cachedPlaintext={decryptedCacheRef.current.get(msg.id)}
                              refreshKey={decryptRefreshKey}
                              messageId={msg.id}
                              hasMedia={!!msg.image_url}
                            />
                          </div>
                        )}


                        {reactions.length > 0 && (
                          <div className="flex items-center -mt-1 px-0.5">
                            <div className="flex items-center gap-0.5 bg-background border border-border/40 rounded-full px-1.5 py-0.5 shadow-sm">
                              {Object.entries(
                                reactions.reduce<Record<string, number>>((acc, r) => {
                                  acc[r.emoji] = (acc[r.emoji] || 0) + 1;
                                  return acc;
                                }, {})
                              ).map(([emoji, count]) => (
                                <button
                                  key={emoji}
                                  onClick={() => toggleReaction(msg.id, emoji)}
                                  className="flex items-center gap-0.5 text-[10px] hover:scale-110 transition-transform"
                                >
                                  <span>{emoji}</span>
                                  {count > 1 && <span className="text-muted-foreground">{count}</span>}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {isLastInGroup && (
                          <div className="flex items-center gap-0.5 mt-0.5 px-0.5 flex-wrap">
                            <span className="text-[8px] text-muted-foreground">{format(new Date(msg.created_at), 'HH:mm')}</span>
                            {stableBadgeState.encrypted && msg.body.startsWith('{') && (msg.body.includes('"ct"') || msg.body.includes('"hdr"')) && (
                              <EncryptionBadge
                                encrypted
                                verified={decryptedCacheRef.current.has(msg.id) && stableBadgeState.verified}
                                ratchetActive={stableBadgeState.ratchetActive}
                                size="xs"
                                showLabel
                              />
                            )}
                            {isMe && (
                              <>
                                <CheckCheck className="w-2.5 h-2.5 text-primary/60" />
                                <span className="text-[8px] text-primary/70">
                                  {msg.status === 'delivered' ? 'Délivré' : 'En attente'}
                                </span>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Pending outbound messages (local queue) */}
          {queue.pendingMessages.map(pm => (
            <div key={pm.localId} className="flex justify-start mt-1 px-2">
              <div className="max-w-[78%]">
              {(() => {
                const text = pm.plaintext || '';
                const media = parseMediaMessage(text);
                // Pure media: render media only, no bleu bubble
                if (pm.imageUrl && media) {
                  return (
                    <div className="rounded-xl overflow-hidden shadow-sm opacity-70">
                      <EncryptedMedia
                        encryptedUrl={pm.imageUrl}
                        mediaKeyB64={media.keyB64}
                        isVideo={isVideoMediaLabel(media.label)}
                      />
                    </div>
                  );
                }
                if (isGifMessage(text)) {
                  const gifUrl = sanitizeUrl(getGifUrl(text));
                  return gifUrl === '#'
                    ? null
                    : <img src={gifUrl} alt="GIF" className="max-w-full max-h-[150px] object-cover rounded-xl opacity-70" />;
                }
                if (isVoiceMessage(text)) {
                  const vd = getVoiceData(text);
                  return vd
                    ? <VoiceMessagePlayer audioUrl={vd.url} duration={vd.duration} isMe />
                    : <div className="px-3 py-1.5 text-xs rounded-2xl bg-primary/70 text-primary-foreground">Message vocal</div>;
                }
                return (
                  <div className={cn(
                    'px-3 py-1.5 text-xs break-words leading-relaxed rounded-2xl bg-primary/70 text-primary-foreground',
                    pm.status === 'failed_visible' && 'bg-destructive/20 text-destructive border border-destructive/30',
                  )}>
                    {media?.label || text || '...'}
                  </div>
                );
              })()}
                <OutboundStatusIndicator
                  status={pm.status}
                  lastError={pm.lastError}
                  onRetry={() => queue.retryMessage(pm.localId)}
                  onRemove={() => queue.removeMessage(pm.localId)}
                  className="mt-0 text-[9px]"
                />
              </div>
            </div>
          ))}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {showScrollDown && (
        <button
          onClick={() => scrollToBottom()}
          className="absolute bottom-[74px] right-3 z-30 w-8 h-8 rounded-full bg-background shadow-lg border border-border/40 flex items-center justify-center hover:bg-secondary transition-colors"
          title="Revenir aux derniers messages"
          aria-label="Revenir aux derniers messages"
        >
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        </button>
      )}

      {/* Negotiation product banner - bottom */}
      {negotiationProduct && (
        <div className="mx-2 mt-1 mb-1 bg-primary/5 border border-primary/20 rounded-xl px-3 py-2">
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

          {acceptedNeg && !isSeller && (
            <div className="mt-2 space-y-2">
              <div className="flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-600" />
                <span className="text-[10px] font-semibold text-emerald-700">Prix négocié accepté</span>
              </div>
              
              {/* Price breakdown */}
              <div className="bg-secondary/60 rounded-lg p-2 space-y-1 text-[10px]">
                <div className="flex justify-between">
                  <span>Prix négocié</span>
                  <span className="font-semibold">{(acceptedNeg.counter_price || acceptedNeg.offered_price).toFixed(2)} €</span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>Frais de service (5%)</span>
                  <span>{((acceptedNeg.counter_price || acceptedNeg.offered_price) * 0.05).toFixed(2)} €</span>
                </div>
                {selectedRelay && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>Livraison Mondial Relay</span>
                    <span>{estimateShipping(500).toFixed(2)} €</span>
                  </div>
                )}
                <div className="border-t border-border/30 pt-1 flex justify-between font-bold">
                  <span>Total</span>
                  <span>
                    {((acceptedNeg.counter_price || acceptedNeg.offered_price) * 1.05 + (selectedRelay ? estimateShipping(500) : 0)).toFixed(2)} €
                  </span>
                </div>
              </div>

              {/* Relay point selection */}
              <div className="space-y-1.5">
                {selectedRelay ? (
                  <div className="flex items-center gap-1.5 bg-primary/5 rounded-lg p-1.5 text-[10px]">
                    <MapPin className="w-3 h-3 text-primary flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold truncate">{selectedRelay.name}</p>
                      <p className="text-muted-foreground truncate">{selectedRelay.address}, {selectedRelay.postcode} {selectedRelay.city}</p>
                    </div>
                    <button onClick={() => setSelectedRelay(null)} className="text-muted-foreground hover:text-foreground">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" className="w-full h-7 text-[10px] rounded-lg gap-1"
                    onClick={() => setShowRelayPicker(true)}>
                    <Truck className="w-3 h-3" /> Choisir un point relais
                  </Button>
                )}
              </div>

              <Button size="sm" className="w-full h-8 rounded-xl text-[10px] gap-1 premium-button"
                onClick={handlePayNegotiated} disabled={negPayLoading}>
                {negPayLoading ? (
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-primary-foreground border-t-transparent animate-spin" />
                ) : (
                  <><CreditCard className="w-3.5 h-3.5" /> Payer {((acceptedNeg.counter_price || acceptedNeg.offered_price) * 1.05 + (selectedRelay ? estimateShipping(500) : 0)).toFixed(2)} €</>
                )}
              </Button>
            </div>
          )}

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

      {/* Relay Point Picker for negotiation payment */}
      {showRelayPicker && (
        <div className="mx-2 mt-1 mb-1 border border-border/40 rounded-xl overflow-hidden bg-background shadow-lg">
          <div className="flex items-center justify-between px-3 py-1.5 bg-primary/5 border-b border-border/30">
            <span className="text-[10px] font-semibold flex items-center gap-1"><MapPin className="w-3 h-3" /> Point Relais</span>
            <button onClick={() => setShowRelayPicker(false)}><X className="w-3 h-3" /></button>
          </div>
          <div className="max-h-[200px] overflow-y-auto">
            <RelayPointPicker
              selectedId={selectedRelay?.id}
              onSelect={(point) => {
                setSelectedRelay({
                  id: point.id,
                  name: point.name,
                  address: point.address,
                  postcode: point.postcode,
                  city: point.city,
                  country: point.country,
                });
                setShowRelayPicker(false);
              }}
            />
          </div>
        </div>
      )}

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
          onSelect={async (gifUrl) => {
            const body = `GIF:${gifUrl}`;
            if (isZeusConversation) {
              sendMessage.mutate({ conversationId, body });
            } else {
              queue.sendMessage(body).catch(() => toast.error('Erreur envoi GIF'));
            }
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
          onSend={async (audioUrl, duration, encryptedBody) => {
            const body = encryptedBody || `🎙️ voice:${audioUrl}|dur:${duration}`;
            if (isZeusConversation) {
              sendMessage.mutate({ conversationId, body });
            } else {
              queue.sendMessage(body).catch(() => toast.error('Erreur envoi vocal'));
            }
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
              <button
                type="button"
                onClick={() => {
                  if (sendBlocked) {
                    if (e2ee.peerKeyMissing) {
                      toast.error('Clés du contact indisponibles — impossible d’envoyer une photo pour le moment.');
                    } else if (e2ee.initError === 'pin_unlock_required') {
                      toast.error('Déverrouille d’abord la messagerie sécurisée pour envoyer une photo.');
                    } else if (e2ee.initError === 'identity_lost_backup_available') {
                      toast.error('Restaure d’abord ton identité sécurisée avant d’envoyer une photo.');
                    }
                    return;
                  }

                  fileInputRef.current?.click();
                }}
                disabled={isUploading || sendBlocked}
                className="w-7 h-7 rounded-full flex items-center justify-center text-muted-foreground hover:text-primary transition-colors disabled:opacity-50 disabled:pointer-events-none"
              >
                {isUploading ? <div className="w-3.5 h-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin" /> : <Camera className="w-4 h-4" />}
              </button>
              <button
                type="button"
                onClick={() => {
                  setViewOnceArmed(v => !v);
                  if (!viewOnceArmed) toast.success('Vue Unique armée pour le prochain média 🔥');
                }}
                title="Vue unique"
                className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center transition-colors",
                  viewOnceArmed ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-primary"
                )}
              >
                <Eye className="w-4 h-4" />
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
              <button type="submit" disabled={sendMessage.isPending} className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center flex-shrink-0 hover:bg-primary/90 transition-colors disabled:opacity-50">
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
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', check, { passive: true });
    return () => window.removeEventListener('resize', check);
  }, []);

  if (!user || !state.isOpen) return null;

  // Minimized state - show a small bubble (desktop only)
  if (state.isMinimized && !isMobile) {
    return (
      <button
        onClick={restoreChat}
        className="fixed bottom-0 right-[90px] z-[60] w-12 h-12 rounded-t-lg bg-primary text-primary-foreground shadow-lg flex items-center justify-center hover:scale-105 active:scale-95 transition-all animate-in zoom-in-75"
      >
        <Send className="w-5 h-5" />
      </button>
    );
  }

  // Mobile: full-screen overlay so the unique ChatWidget runtime is reachable on phones
  if (isMobile) {
    if (state.isMinimized) return null;
    return (
      <div className="fixed inset-0 z-[80] bg-background flex flex-col animate-in slide-in-from-right-4 duration-200 overflow-hidden">
        <MessagingPinGate compact>
          {state.conversationId ? (
            <WidgetChatView conversationId={state.conversationId} />
          ) : (
            <WidgetConversationList />
          )}
        </MessagingPinGate>
      </div>
    );
  }

  return (
    <div className="fixed bottom-0 right-[80px] z-[60] w-[328px] h-[455px] bg-background border border-border/40 rounded-t-lg shadow-2xl shadow-black/20 flex flex-col animate-in slide-in-from-bottom-4 duration-200 overflow-hidden">
      <MessagingPinGate compact>
        {state.conversationId ? (
          <WidgetChatView conversationId={state.conversationId} />
        ) : (
          <WidgetConversationList />
        )}
      </MessagingPinGate>
    </div>
  );
}
