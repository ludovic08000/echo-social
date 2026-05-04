import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';

import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Send, Plus, Smile, Phone, Video,
  Camera, X, CheckCheck, Pin, PinOff, ChevronDown,
  Forward, Users, UserPlus, LogOut, Crown, UserMinus, Sparkles, Info,
  AlertTriangle, Languages
} from 'lucide-react';
import { format, isSameDay } from 'date-fns';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { useConversations, useMessages, useSendMessage, useMarkConversationRead, useDeleteMessageForMe, useDeleteMessageForEveryone, useLeaveGroup, useAddGroupMembers, useRemoveGroupMember, useGroupMembers, type Message } from '@/hooks/useMessages';
import { useMessageReactions } from '@/hooks/useMessageReactions';
import { useFriendships } from '@/hooks/useFriendships';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useCall, CallType, generateCallE2EEKey } from '@/hooks/useCall';
import { signalOutgoingCall, endActiveCall } from '@/hooks/useIncomingCall';
import { CallOverlay } from '@/components/CallOverlay';
import { useImageUpload } from '@/hooks/useImageUpload';
import { toast } from 'sonner';
import { useMessageTranslation } from '@/hooks/useMessageTranslation';
import { useE2EE } from '@/hooks/useE2EE';
import { generateMediaKey, encryptMedia, buildMediaMessageBody, parseMediaMessage, isImageMediaLabel, isVideoMediaLabel } from '@/lib/crypto/mediaEncrypt';
import { logCryptoException, logCryptoError } from '@/lib/crypto/errorLogger';
import { compressImageForChat } from '@/lib/messaging/compressImage';
import { MessageMedia } from './MessageMedia';
import { EncryptedMedia } from './EncryptedMedia';
import { rememberDecryptedMedia } from './decryptedMediaCache';
import { useMessageQueue } from '@/hooks/useMessageQueue';
import { EncryptionBadge, EncryptionStatusBar } from './EncryptionBadge';
import { DecryptedMessageBody } from './DecryptedMessageBody';
import { OutboundStatusIndicator } from './OutboundStatus';

import { MessageActions } from './MessageActions';
import { TypingIndicator } from './TypingIndicator';
import { VoiceRecorder, VoiceMessagePlayer } from '@/components/chat/VoiceRecorder';
import { Mic } from 'lucide-react';
import { ForwardMessageDialog } from './ForwardMessageDialog';
import { NewConversationDialog } from './NewConversationDialog';
import { ShareContentPicker } from './ShareContentPicker';
import { EMOJI_CATEGORIES, formatDateSeparator, isSingleEmoji } from './constants';
import { savePlaintext, loadPlaintext } from '@/lib/crypto/plaintextStore';
import { useTypingPresence } from '@/hooks/useTypingPresence';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

interface ChatViewProps {
  conversationId: string;
}

function parseGifMessage(text: string): string | null {
  const match = text.match(/^GIF:(https?:\/\/.+)$/i);
  return match ? match[1] : null;
}

function parseVoiceMessage(text: string): { url: string; duration: number } | null {
  const match = text.match(/(?:vocal|voice):(.*?)\|(?:dur:)?(\d+)$/i);
  return match ? { url: match[1], duration: parseInt(match[2], 10) } : null;
}

/**
 * In-memory mirror of the persistent IndexedDB plaintext cache.
 * - Hot path for synchronous reads (copy/reply/forward).
 * - Persisted asynchronously to IndexedDB via savePlaintext() so messages
 *   stay readable after a page reload — for both sender and receiver.
 *   The persistent layer is encrypted with a non-extractable device key
 *   that never leaves the browser; the server still only sees ciphertext.
 */
const decryptedCache = new Map<string, string>();

export function ChatView({ conversationId }: ChatViewProps) {
  const { user } = useAuth();
  const { data: conversations } = useConversations();
  const { data: messages, isLoading } = useMessages(conversationId);
  // Plaintext DB send is reserved for Zeus bot conversations only.
  const botPlaintextSend = useSendMessage();
  const deleteForMe = useDeleteMessageForMe();
  const deleteForEveryone = useDeleteMessageForEveryone();
  const markRead = useMarkConversationRead();
  const [newMessage, setNewMessage] = useState('');
  const [showEmojis, setShowEmojis] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  // Reactions are now persisted + realtime via useMessageReactions
  // peerTyping is driven by the realtime presence channel below — never by local input.
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [showSharePicker, setShowSharePicker] = useState(false);
  const [pinnedMessages, setPinnedMessages] = useState<Set<string>>(new Set());
  const [forwardMsg, setForwardMsg] = useState<{ id: string; plaintext: string } | null>(null);
  const [showGroupPanel, setShowGroupPanel] = useState(false);
  const [showInvitePanel, setShowInvitePanel] = useState(false);
  const [inviteSearch, setInviteSearch] = useState('');
  const [showNewChat, setShowNewChat] = useState(false);
  const [isSending] = useState(false);
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);
  const { translations, translating, translate: translateMsg, autoTranslateMessages } = useMessageTranslation();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-translate disabled
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const conversation = conversations?.find(c => c.id === conversationId);
  const isGroup = conversation?.is_group || false;
  const leaveGroup = useLeaveGroup();
  const addMembers = useAddGroupMembers();
  const removeMember = useRemoveGroupMember();
  const { data: groupMembers = [] } = useGroupMembers(isGroup ? conversationId : undefined);
  const { data: friendsData } = useFriendships();
  const allFriends = friendsData?.friends || [];
  const navigate = useNavigate();
  const peerUserId = conversation?.participant?.user_id;
  const isZeusConversation = peerUserId === '00000000-0000-0000-0000-000000000001';
  const e2ee = useE2EE(conversationId, peerUserId);
  const { data: recoveryState } = useQuery({
    queryKey: ['conversation-recovery-state', conversationId, user?.id ?? 'anon'],
    enabled: !!conversationId && !!user && !isZeusConversation,
    refetchOnMount: 'always',
    refetchOnReconnect: 'always',
    queryFn: async () => {
      if (!conversationId || !user) return null;

      const [{ hasWrappedKeys }, { hasRawIdentityKeys }] = await Promise.all([
        import('@/lib/crypto/pinWrap'),
        import('@/lib/crypto/keyManager'),
      ]);

      const [wrappedKeysPresent, rawIdentityPresent, backupCountResult, messageCountResult] = await Promise.all([
        hasWrappedKeys(user.id),
        hasRawIdentityKeys(user.id),
        supabase.from('user_backups' as any).select('id', { count: 'exact', head: true }).eq('user_id', user.id),
        supabase.from('messages').select('id', { count: 'exact', head: true }).eq('conversation_id', conversationId).in('status', ['delivered', 'pending']),
      ]);

      const serverMessageCount = messageCountResult.count ?? 0;
      const hasServerBackup = (backupCountResult.count ?? 0) > 0;
      const needsPinUnlock = !rawIdentityPresent && wrappedKeysPresent;
      const needsExplicitRestore = !rawIdentityPresent && !wrappedKeysPresent && hasServerBackup;

      console.log('[messaging] conversation restore state', {
        conversationId,
        userId: user.id,
        serverMessageCount,
        rawIdentityPresent,
        wrappedKeysPresent,
        hasServerBackup,
        needsPinUnlock,
        needsExplicitRestore,
      });

      return {
        serverMessageCount,
        rawIdentityPresent,
        wrappedKeysPresent,
        hasServerBackup,
        needsPinUnlock,
        needsExplicitRestore,
      };
    },
  });
  const { peerTyping, notifyTyping, notifyStopped } = useTypingPresence(
    conversationId,
    user?.id,
    peerUserId,
  );
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

  // Cache plaintext for own sent messages (ratchet can't decrypt own ciphertext).
  // Persisted to IndexedDB (device-key encrypted) so the message stays readable
  // after a page reload.
  const handlePlaintextCached = useCallback((serverId: string, plaintext: string) => {
    decryptedCache.set(serverId, plaintext);
    bumpCache();
    void savePlaintext(serverId, plaintext);
  }, [bumpCache]);

  // When E2EE keys are restored after login, drop empty/placeholder entries
  // and re-trigger decryption so previously-hidden messages re-appear in clear.
  useEffect(() => {
    const handler = () => {
      for (const [k, v] of decryptedCache) {
        if (!v) decryptedCache.delete(k);
      }
      bumpCache();
    };
    window.addEventListener('forsure-keys-restored', handler);
    return () => window.removeEventListener('forsure-keys-restored', handler);
  }, [bumpCache]);

  // Message queue for encrypted sending.
  // STRICT: plaintext is allowed ONLY for the Zeus bot conversation.
  // Any peer conversation MUST go through E2EE — if encryption is not ready,
  // the message stays queued (never sent in clear).
  const isEncryptionActive = !isZeusConversation && e2ee.encrypted;

  const queue = useMessageQueue(
    conversationId,
    e2ee.encrypt,
    e2ee.isReady(),
    isEncryptionActive,
    e2ee.acknowledgeSentPayload,
    isZeusConversation, // allowPlaintext — Zeus only
    handlePlaintextCached,
  );

  const { upload: rawUpload, isUploading } = useImageUpload({
    bucket: 'post-images',
  });

  // Wrap upload: encrypt media before upload when E2EE is active
  const handleMediaFile = useCallback(async (file: File) => {
    const isVideo = /\.(mp4|mov|webm|avi|mkv)/i.test(file.name);
    const label = isVideo ? '🎬 Vidéo' : '📷 Photo';

    // Compress still images before upload (skipped for videos / tiny files).
    const prepared = isVideo ? file : await compressImageForChat(file);

    if (isZeusConversation) {
      const url = await rawUpload(prepared);
      if (url) {
        botPlaintextSend.mutate({ conversationId, body: label, imageUrl: url });
      }
      return;
    }

    if (e2ee.peerKeyMissing) {
      toast.error('Clés du contact indisponibles — impossible d’envoyer un média pour le moment.');
      return;
    }

    if (e2ee.initError === 'pin_unlock_required') {
      toast.error('Déverrouille d’abord la messagerie sécurisée pour envoyer un média.');
      return;
    }

    if (e2ee.initError === 'identity_lost_backup_available') {
      toast.error('Restaure d’abord ton identité sécurisée avant d’envoyer un média.');
      return;
    }

    const t0 = performance.now();
    try {
      const { key, keyB64 } = await generateMediaKey();
      const encryptedBlob = await encryptMedia(prepared, key);
      const encFile = new File([encryptedBlob], `${prepared.name}.enc`, { type: 'application/octet-stream' });
      const url = await rawUpload(encFile);
      if (url) {
        // Pre-seed the cache with the local plaintext blob so the sender
        // sees their image instantly, without R2 round-trip + decrypt.
        try {
          const localUrl = URL.createObjectURL(prepared);
          rememberDecryptedMedia(url, localUrl, isVideo);
        } catch { /* noop */ }
        const body = buildMediaMessageBody(label, keyB64);
        queue.sendMessage(body, url).catch((e) => {
          logCryptoException('media', e, { severity: 'error', conversationId, metadata: { stage: 'queue_send', isVideo } });
          toast.error('Erreur envoi média');
        });
        logCryptoError({
          severity: 'info', context: 'media', errorCode: 'MEDIA_ENCRYPT_OK',
          errorMessage: 'Media encrypted and uploaded',
          conversationId,
          metadata: { sizeBytes: prepared.size, mime: prepared.type, isVideo, durationMs: Math.round(performance.now() - t0) },
        });
      } else {
        logCryptoError({
          severity: 'error', context: 'media', errorCode: 'MEDIA_UPLOAD_FAILED',
          errorMessage: 'Encrypted media upload returned no URL',
          conversationId,
          metadata: { sizeBytes: prepared.size, mime: prepared.type, isVideo },
        });
      }
    } catch (err) {
      console.error('Media encryption failed:', err);
      logCryptoException('media', err, {
        severity: 'error',
        conversationId,
        metadata: { stage: 'encrypt_upload', sizeBytes: prepared.size, mime: prepared.type, isVideo, durationMs: Math.round(performance.now() - t0) },
      });
      toast.error('Erreur de chiffrement du média');
    }
  }, [
    isZeusConversation,
    rawUpload,
    conversationId,
    botPlaintextSend,
    queue,
    e2ee.fingerprintChanged,
    e2ee.peerKeyMissing,
    e2ee.initError,
  ]);

  const {
    callState, callType, isMuted, isCameraOff, duration, isE2eeActive,
    localVideoRef, remoteVideoRef,
    startCall, endCall, toggleMute, toggleCamera, switchToVideo, switchCamera,
  } = useCall();


  const activeCallIdRef = useRef<string | null>(null);

  const handleStartCall = useCallback(async (type: CallType) => {
    if (!user || !peerUserId) return;
    const callKey = generateCallE2EEKey();
    // signalOutgoingCall encrypts the key before DB storage
    const callId = await signalOutgoingCall(conversationId, user.id, peerUserId, type, callKey);
    if (!callId) {
      toast.error("Impossible de signaler l'appel. Réessayez.");
      return;
    }
    activeCallIdRef.current = callId;
    // Pass raw key directly to LiveKit — never persisted in state
    startCall(conversationId, type, callKey);
  }, [user, peerUserId, conversationId, startCall]);

  const handleEndCall = useCallback(() => {
    if (activeCallIdRef.current) {
      endActiveCall(activeCallIdRef.current);
      activeCallIdRef.current = null;
    }
    endCall();
  }, [endCall]);
  // NOTE: no real peer "typing" signal exists yet (would require an
  // ephemeral realtime presence channel). Previously this effect faked it
  // from our OWN input, which falsely displayed "X est en train d'écrire"
  // for the recipient while they were idle. Disabled until a true presence
  // channel is implemented.


  const lastScrollSigRef = useRef<string>('');
  useEffect(() => {
    const lastMsgId = messages?.length ? messages[messages.length - 1].id : '';
    const lastPendingId = queue.pendingMessages.length
      ? queue.pendingMessages[queue.pendingMessages.length - 1].localId
      : '';
    const sig = `${messages?.length ?? 0}:${lastMsgId}|${queue.pendingMessages.length}:${lastPendingId}`;
    if (sig === lastScrollSigRef.current) return;
    lastScrollSigRef.current = sig;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, queue.pendingMessages]);

  useEffect(() => {
    if (conversationId) markRead.mutate(conversationId);
  }, [conversationId]);

  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    setShowScrollDown(scrollHeight - scrollTop - clientHeight > 200);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  /**
   * Get the decrypted text for a message. Falls back to the cache
   * populated by DecryptedMessageBody.
   */
  const getDecryptedText = useCallback((msg: Message): string => {
    const cached = decryptedCache.get(msg.id);
    if (cached) {
      const parsed = parseMediaMessage(cached);
      return parsed ? parsed.label : cached;
    }
    // If it doesn't look encrypted, return body
    const looksEncrypted = msg.body.startsWith('{') && (msg.body.includes('"ct"') || msg.body.includes('"hdr"'));
    if (!looksEncrypted) return msg.body;
    // Fallback: never show raw ciphertext
    return '🔒 Message chiffré';
  }, []);



  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || isSending) return;

    // Hard blockers — show a clear reason and abort
    if (!isZeusConversation) {
      if (e2ee.peerKeyMissing) {
        toast.error('Clés du contact indisponibles — réessaie dans un instant.');
        return;
      }
      if (e2ee.initError === 'pin_unlock_required') {
        toast.error('Déverrouille la messagerie sécurisée pour envoyer.');
        return;
      }
      if (e2ee.initError === 'identity_lost_backup_available') {
        toast.error('Restaure ton identité sécurisée avant d’envoyer.');
        return;
      }
    }

    const body = replyTo
      ? `↩️ ${replyTo.profile.name}: "${getDecryptedText(replyTo).slice(0, 50)}${getDecryptedText(replyTo).length > 50 ? '…' : ''}"\n\n${newMessage.trim()}`
      : newMessage.trim();

    // Clear input IMMEDIATELY for instant UX
    setNewMessage('');
    setReplyTo(null);
    setShowEmojis(false);
    if (!isZeusConversation) notifyStopped();
    inputRef.current?.focus();

    if (isZeusConversation) {
      botPlaintextSend.mutate({ conversationId, body });
    } else {
      // If E2EE not yet ready: queue the message — it will encrypt + send
      // as soon as the secure channel is established. Show a soft hint so
      // the user knows it's pending (avoids the iOS "dead button" feeling).
      if (!e2ee.isReady()) {
        toast.message('Message en file — envoi dès que le canal sécurisé est prêt.');
      }
      // Fire-and-forget: queue handles retry/encryption in background
      queue.sendMessage(body).catch(err => {
        const msg = err instanceof Error ? err.message : 'Erreur envoi';
        toast.error(msg);
      });
    }
  };

  // Hard blockers ONLY disable the UI. We intentionally do NOT disable the
  // send button while E2EE is merely "initializing" — on iOS the channel can
  // take 10-60s to come up and a disabled button looks broken. The queue
  // safely holds the message and encrypts it when keys are ready.
  const encryptionReady = isZeusConversation || e2ee.isReady();
  const sendBlocked = !isZeusConversation && (
    e2ee.peerKeyMissing ||
    e2ee.initError === 'pin_unlock_required' ||
    e2ee.initError === 'identity_lost_backup_available'
  );

  const handleImageUpload = () => {
    if (sendBlocked) {
      if (e2ee.peerKeyMissing) {
        toast.error('Clés du contact indisponibles — impossible d’envoyer un média pour le moment.');
      } else if (e2ee.initError === 'pin_unlock_required') {
        toast.error('Déverrouille d’abord la messagerie sécurisée pour envoyer un média.');
      } else if (e2ee.initError === 'identity_lost_backup_available') {
        toast.error('Restaure d’abord ton identité sécurisée avant d’envoyer un média.');
      } else if (!encryptionReady) {
        toast.error('Canal sécurisé en cours d’initialisation — réessaie dans quelques secondes.');
      }
      return;
    }

    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleMediaFile(file);
    e.target.value = '';
  };

  const messageIds = useMemo(() => (messages || []).map(m => m.id), [messages]);
  const { reactions: reactionsByMessage, toggleReaction } = useMessageReactions(conversationId, messageIds);

  const handleReact = (msgId: string, emoji: string) => {
    void toggleReaction(msgId, emoji);
  };

  const handleCopy = (msg: Message) => {
    const text = getDecryptedText(msg);
    navigator.clipboard.writeText(text);
    toast.success('Message copié');
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

  /** Callback from DecryptedMessageBody to cache decrypted text + persist it */
  const onDecrypted = useCallback((msgId: string, text: string) => {
    const parsed = parseMediaMessage(text);
    decryptedCache.set(msgId, parsed ? text : text);
    bumpCache();
    void savePlaintext(msgId, parsed ? text : text);
  }, [bumpCache]);

  // Pre-warm the in-memory cache from the persistent IndexedDB store as soon as
  // we know which messages are in the conversation. This keeps copy/reply/forward
  // working synchronously even right after a reload.
  useEffect(() => {
    if (!messages?.length) return;
    let cancelled = false;
    (async () => {
      let added = false;
      for (const msg of messages) {
        if (decryptedCache.has(msg.id)) continue;
        const pt = await loadPlaintext(msg.id);
        if (cancelled) return;
        if (pt) { decryptedCache.set(msg.id, pt); added = true; }
      }
      if (added && !cancelled) bumpCache();
    })();
    return () => { cancelled = true; };
  }, [messages, bumpCache]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <input ref={fileInputRef} type="file" accept="image/*,video/*" className="hidden" onChange={handleFileChange} />

      {/* Header */}
      <header className="sticky top-0 z-40 bg-background border-b border-border/40 safe-area-pt">
        <div className="flex items-center gap-2 px-3 h-[60px]">
          <Link to="/messages">
            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>

          {conversation && (
            conversation.is_group ? (
              <button onClick={() => setShowGroupPanel(!showGroupPanel)} className="flex items-center gap-2.5 flex-1 min-w-0">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary/30 to-primary/10 flex items-center justify-center text-lg flex-shrink-0">
                  👥
                </div>
                <div className="min-w-0 text-left">
                  <span className="text-[15px] font-semibold block truncate leading-tight">{conversation.name || 'Groupe'}</span>
                  <span className="text-[11px] text-muted-foreground leading-tight">
                    {groupMembers.length} membres
                  </span>
                </div>
              </button>
            ) : (
              <Link to={`/profile/${conversation.participant.user_id}`} className="flex items-center gap-2.5 flex-1 min-w-0">
                <div className="relative">
                  <UserAvatar src={conversation.participant.avatar_url} alt={conversation.participant.name} size="sm" />
                  <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 border-2 border-background" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[15px] font-semibold block truncate leading-tight">{conversation.participant.name}</span>
                    {!isZeusConversation && stableBadgeState.encrypted && (
                      <EncryptionBadge
                        encrypted
                        verified={stableBadgeState.verified}
                        ratchetActive={stableBadgeState.ratchetActive}
                        size="sm"
                        showLabel
                        className="shrink-0"
                      />
                    )}
                  </div>
                  <span className="text-[11px] text-emerald-600 dark:text-emerald-400 leading-tight">Actif(ve) maintenant</span>
                </div>
              </Link>
            )
          )}

          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full text-primary" onClick={() => handleStartCall('audio')} disabled={callState !== 'idle'}>
              <Phone className="w-5 h-5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full text-primary" onClick={() => handleStartCall('video')} disabled={callState !== 'idle'}>
              <Video className="w-5 h-5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full text-primary" onClick={() => setShowGroupPanel(!showGroupPanel)}>
              <Info className="w-5 h-5" />
            </Button>
          </div>
        </div>
      </header>

      {/* E2EE Status Bar */}
      <EncryptionStatusBar
        encrypted={e2ee.encrypted}
        fingerprint={e2ee.fingerprint}
        peerFingerprint={e2ee.peerFingerprint}
        ratchetActive={e2ee.ratchetActive}
        fingerprintChanged={e2ee.fingerprintChanged}
        peerName={conversation?.participant?.name || 'Contact'}
        conversationId={conversationId}
      />

      {/* Key lost / init error / fingerprint change recovery banner */}
      {!isZeusConversation && e2ee.initError && (
        <div className="flex flex-col gap-2 px-4 py-3 bg-destructive/10 border-b border-destructive/20">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-destructive flex-shrink-0" />
            <span className="text-xs text-destructive font-semibold flex-1">
              {e2ee.initError === 'identity_lost_backup_available'
                ? '🔑 Vos clés de chiffrement ont été perdues. Restaurez votre sauvegarde pour retrouver vos messages.'
                : e2ee.initError === 'pin_unlock_required'
                  ? '🔐 Déverrouillez votre PIN pour accéder à vos clés de chiffrement.'
                  : e2ee.initError === 'fingerprint_changed'
                    ? '🛑 L\'identité cryptographique de votre contact a changé. Cela peut indiquer un changement d\'appareil légitime ou une tentative d\'interception. Vérifiez avec votre contact avant d\'accepter.'
                    : '⚠️ Erreur d\'initialisation du chiffrement. Restaurez vos clés pour reprendre vos conversations.'}
            </span>
          </div>
          {e2ee.initError === 'fingerprint_changed' ? (
            <button
              onClick={() => e2ee.acknowledgeFingerprint()}
              className="self-start px-4 py-1.5 rounded-full bg-destructive text-destructive-foreground text-xs font-semibold hover:opacity-90 transition-opacity"
            >
              ✅ J'ai vérifié, accepter la nouvelle clé
            </button>
          ) : (
            <button
              onClick={() => navigate('/settings', { state: { tab: 'privacy', scrollTo: 'key-backup' } })}
              className="self-start px-4 py-1.5 rounded-full bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 transition-opacity"
            >
              🔑 Restaurer mes clés
            </button>
          )}
        </div>
      )}

      {/* Peer has no keys — can't encrypt */}
      {!isZeusConversation && e2ee.peerKeyMissing && !e2ee.initError && (
        <div className="flex items-center gap-2 px-4 py-2 bg-muted border-b border-border/30">
          <AlertTriangle className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <span className="text-[11px] text-muted-foreground font-medium flex-1">
            🔒 Ce contact n'a pas encore publié ses clés de chiffrement. Les messages ne peuvent pas être envoyés pour l'instant.
          </span>
        </div>
      )}

      {/* Group Management Panel */}
      {isGroup && showGroupPanel && (
        <div className="border-b border-border/30 bg-card animate-in slide-in-from-top-2">
          <div className="px-4 py-3 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold flex items-center gap-2">
                <Users className="w-4 h-4 text-primary" />
                Membres ({groupMembers.length})
              </h3>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowInvitePanel(!showInvitePanel)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  Inviter
                </button>
                <button
                  onClick={async () => {
                    if (confirm('Voulez-vous vraiment quitter ce groupe ?')) {
                      try {
                        await leaveGroup.mutateAsync(conversationId);
                        toast.success('Vous avez quitté le groupe');
                        navigate('/messages');
                      } catch { toast.error('Erreur'); }
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-destructive/10 text-destructive text-xs font-medium hover:bg-destructive/20 transition-colors"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Quitter
                </button>
              </div>
            </div>

            <div className="space-y-1 max-h-48 overflow-y-auto">
              {groupMembers.map(member => (
                <div key={member.user_id} className="flex items-center gap-2.5 py-1.5 px-2 rounded-xl hover:bg-secondary/40 transition-colors">
                  <Link to={`/profile/${member.user_id}`}>
                    <UserAvatar src={member.avatar_url} alt={member.name} size="sm" />
                  </Link>
                  <Link to={`/profile/${member.user_id}`} className="flex-1 min-w-0">
                    <span className="text-xs font-medium truncate block">{member.name}</span>
                    {conversation?.created_by === member.user_id && (
                      <span className="text-[10px] text-primary flex items-center gap-0.5"><Crown className="w-2.5 h-2.5" /> Admin</span>
                    )}
                  </Link>
                  {conversation?.created_by === user?.id && member.user_id !== user?.id && (
                    <button
                      onClick={async () => {
                        if (confirm(`Retirer ${member.name} du groupe ?`)) {
                          try {
                            await removeMember.mutateAsync({ conversationId, userId: member.user_id });
                            toast.success(`${member.name} a été retiré`);
                          } catch { toast.error('Erreur'); }
                        }
                      }}
                      className="p-1.5 rounded-full hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <UserMinus className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {showInvitePanel && (
              <div className="border-t border-border/20 pt-3 space-y-2">
                <input
                  value={inviteSearch}
                  onChange={e => setInviteSearch(e.target.value)}
                  placeholder="Rechercher un ami à inviter…"
                  className="w-full bg-secondary/60 rounded-xl px-3 py-2 text-xs outline-none placeholder:text-muted-foreground"
                />
                <div className="space-y-1 max-h-36 overflow-y-auto">
                  {allFriends
                    .filter(f => {
                      const alreadyMember = groupMembers.some(m => m.user_id === f.profile.user_id);
                      const matchesSearch = !inviteSearch.trim() || f.profile.name.toLowerCase().includes(inviteSearch.toLowerCase());
                      return !alreadyMember && matchesSearch;
                    })
                    .map(f => (
                      <div key={f.profile.user_id} className="flex items-center gap-2.5 py-1.5 px-2 rounded-xl hover:bg-secondary/40">
                        <UserAvatar src={f.profile.avatar_url} alt={f.profile.name} size="sm" />
                        <span className="text-xs font-medium flex-1 truncate">{f.profile.name}</span>
                        <button
                          onClick={async () => {
                            try {
                              await addMembers.mutateAsync({ conversationId, memberIds: [f.profile.user_id] });
                              toast.success(`${f.profile.name} ajouté au groupe !`);
                            } catch { toast.error('Erreur'); }
                          }}
                          className="px-2.5 py-1 rounded-full bg-primary text-primary-foreground text-[10px] font-medium hover:bg-primary/90 transition-colors"
                        >
                          Inviter
                        </button>
                      </div>
                    ))}
                  {allFriends.filter(f => !groupMembers.some(m => m.user_id === f.profile.user_id)).length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-3">Tous vos amis sont déjà dans le groupe</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Pinned messages */}
      {(() => {
        const pinned = messages?.filter(m => pinnedMessages.has(m.id)) || [];
        if (pinned.length === 0) return null;
        return (
          <div className="sticky top-[60px] z-30 bg-background/95 backdrop-blur-sm border-b border-border/20 px-4 py-2">
            <div className="flex items-center gap-2">
              <Pin className="w-3.5 h-3.5 text-primary flex-shrink-0" />
              <p className="text-xs text-foreground font-medium truncate flex-1">
                📌 {pinned.length === 1 ? getDecryptedText(pinned[0]).slice(0, 60) : `${pinned.length} messages épinglés`}
              </p>
              {pinned.length === 1 && (
                <button onClick={() => setPinnedMessages(prev => { const n = new Set(prev); n.delete(pinned[0].id); return n; })} className="text-muted-foreground hover:text-foreground">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* Messages area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-4 relative"
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          </div>
        ) : messages?.length === 0 && queue.pendingMessages.length === 0 ? (
          (recoveryState?.serverMessageCount ?? 0) > 0 && (
            e2ee.initError === 'pin_unlock_required' ||
            e2ee.initError === 'identity_lost_backup_available' ||
            recoveryState?.needsPinUnlock ||
            recoveryState?.needsExplicitRestore
          ) ? (
            <div className="flex flex-col items-center justify-center py-16 gap-4 px-6">
              <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center">
                <AlertTriangle className="w-7 h-7 text-primary" />
              </div>
              <div className="text-center max-w-[320px]">
                <p className="text-sm font-semibold">Conversation prête à se charger</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {recoveryState?.needsPinUnlock || e2ee.initError === 'pin_unlock_required'
                    ? 'Déverrouillez votre PIN pour accéder à vos messages.'
                    : 'Vos messages sont disponibles. Synchronisez vos clés pour continuer.'}
                </p>
              </div>
              {(recoveryState?.needsExplicitRestore || e2ee.initError === 'identity_lost_backup_available') && (
                <Button
                  variant="secondary"
                  className="rounded-full"
                  size="sm"
                  onClick={() => navigate('/settings', { state: { tab: 'privacy', scrollTo: 'key-backup' } })}
                >
                  Synchroniser mes clés
                </Button>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              {conversation && !conversation.is_group && (
                <>
                  <UserAvatar src={conversation.participant.avatar_url} alt={conversation.participant.name} size="xl" />
                  <p className="text-lg font-bold">{conversation.participant.name}</p>
                  <p className="text-sm text-muted-foreground text-center max-w-[260px]">
                    Vous êtes amis sur Forsure. Dites bonjour ! 👋
                  </p>
                </>
              )}
              <div className="flex flex-wrap gap-2 justify-center max-w-[300px] mt-2">
                {['Salut ! 👋', 'Comment ça va ? 😊', 'Quoi de neuf ? 🤔'].map(suggestion => (
                  <button
                    key={suggestion}
                    onClick={async () => {
                      try {
                        await queue.sendMessage(suggestion);
                      } catch {
                        toast.error('Erreur envoi');
                      }
                    }}
                    className="px-4 py-2 rounded-full bg-primary/10 text-primary text-sm font-medium hover:bg-primary/20 active:scale-95 transition-all"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (

          <>
            {groupedMessages.map((group, gi) => (
              <div key={gi}>
                <div className="flex items-center justify-center my-4">
                  <span className="text-[11px] font-medium text-muted-foreground px-3 py-1 rounded-full bg-secondary/60 capitalize">
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
                    const looksEncrypted = msg.body.startsWith('{') && (msg.body.includes('"ct"') || msg.body.includes('"hdr"'));
                    const isBigEmoji = !looksEncrypted && isSingleEmoji(msg.body);
                    const isImage = msg.image_url;

                    return (
                      <div
                        key={msg.id}
                        className={cn(
                          'flex items-end gap-1.5 relative group',
                          isFirstInGroup ? 'mt-2' : 'mt-px'
                        )}
                      >
                        <div className="w-7 flex-shrink-0 mb-0.5">
                          {isLastInGroup && (
                            <Link to={`/profile/${msg.sender_id}`}>
                              <UserAvatar src={msg.profile.avatar_url} alt={msg.profile.name} size="xs" />
                            </Link>
                          )}
                        </div>

                        <div className="max-w-[70%] flex flex-col relative items-start">
                          <MessageActions
                            isMe={isMe}
                            visible={activeMessageId === msg.id}
                            onClose={() => setActiveMessageId(null)}
                            onReply={() => setReplyTo(msg)}
                            onReact={(emoji) => handleReact(msg.id, emoji)}
                            onCopy={() => handleCopy(msg)}
                            onForward={() => setForwardMsg({ id: msg.id, plaintext: getDecryptedText(msg) })}
                            onPin={() => {
                              setPinnedMessages(prev => {
                                const next = new Set(prev);
                                if (next.has(msg.id)) {
                                  next.delete(msg.id);
                                  toast.success('Message désépinglé');
                                } else {
                                  next.add(msg.id);
                                  toast.success('Message épinglé 📌');
                                }
                                return next;
                              });
                            }}
                            isPinned={pinnedMessages.has(msg.id)}
                            onDeleteForMe={() => {
                              deleteForMe.mutate({ messageId: msg.id, conversationId });
                            }}
                            onDeleteForEveryone={isMe ? () => {
                              deleteForEveryone.mutate({ messageId: msg.id, conversationId });
                            } : undefined}
                            onReport={async () => {
                              const reportText = getDecryptedText(msg);
                              await supabase.from('abuse_reports').insert({
                                reporter_id: user!.id,
                                reported_user_id: msg.sender_id,
                                report_type: 'message',
                                description: `Message signalé: "${reportText.slice(0, 200)}"`,
                              });
                              toast.success('Message signalé. Merci pour votre vigilance.');
                            }}
                          />

                          {pinnedMessages.has(msg.id) && (
                            <div className="flex items-center gap-1 mb-0.5">
                              <Pin className="w-3 h-3 text-primary" />
                              <span className="text-[10px] text-primary font-medium">Épinglé</span>
                            </div>
                          )}

                          {isImage && (
                            <div
                              onClick={() => setActiveMessageId(activeMessageId === msg.id ? null : msg.id)}
                              onContextMenu={(e) => { e.preventDefault(); setActiveMessageId(msg.id); }}
                              className={cn(
                                'overflow-hidden mb-0.5 rounded-[18px] rounded-bl-sm cursor-pointer select-none transition-all duration-100',
                                activeMessageId === msg.id && 'scale-[0.98] opacity-80',
                              )}
                            >
                              <MessageMedia
                                imageUrl={msg.image_url!}
                                body={msg.body}
                                decrypt={e2ee.decrypt}
                                isEncryptionActive={e2ee.encrypted && !isZeusConversation}
                                messageId={msg.id}
                              />
                            </div>
                          )}

                          {(() => {
                            const rawBody = decryptedCache.get(msg.id) || msg.body || '';
                            const media = parseMediaMessage(rawBody);
                            const label = media?.label ?? rawBody;
                            const isPureMediaPlaceholder = !!msg.image_url && (
                              /^📷\s*Photo(MKEY:|$)/i.test(rawBody) ||
                              /^🎬\s*(Video|Vidéo)(MKEY:|$)/i.test(rawBody) ||
                              !!media ||
                              isImageMediaLabel(label) ||
                              isVideoMediaLabel(label)
                            );
                            if (isPureMediaPlaceholder) return null;
                            return (
                          <div
                            onClick={() => setActiveMessageId(activeMessageId === msg.id ? null : msg.id)}
                            onContextMenu={(e) => { e.preventDefault(); setActiveMessageId(msg.id); }}
                            className={cn(
                              'cursor-pointer select-none transition-all duration-100',
                              activeMessageId === msg.id && 'scale-[0.98] opacity-80',
                              isBigEmoji
                                ? 'text-4xl leading-none py-1'
                                : cn(
                                    'px-3 py-1.5 text-[15px] break-words leading-relaxed',
                                    isMe
                                      ? cn(
                                          'bg-primary text-primary-foreground',
                                          isFirstInGroup && isLastInGroup && 'rounded-[18px]',
                                          isFirstInGroup && !isLastInGroup && 'rounded-[18px] rounded-br-[4px]',
                                          !isFirstInGroup && isLastInGroup && 'rounded-[18px] rounded-tr-[4px]',
                                          !isFirstInGroup && !isLastInGroup && 'rounded-[18px] rounded-tr-[4px] rounded-br-[4px]'
                                        )
                                      : cn(
                                          'bg-secondary text-foreground',
                                          isFirstInGroup && isLastInGroup && 'rounded-[18px]',
                                          isFirstInGroup && !isLastInGroup && 'rounded-[18px] rounded-bl-[4px]',
                                          !isFirstInGroup && isLastInGroup && 'rounded-[18px] rounded-tl-[4px]',
                                          !isFirstInGroup && !isLastInGroup && 'rounded-[18px] rounded-tl-[4px] rounded-bl-[4px]'
                                        )
                                  )
                            )}
                          >
                            <DecryptedMessageBody
                              body={msg.body}
                              decrypt={e2ee.decrypt}
                              isEncryptionActive={e2ee.encrypted && !isZeusConversation}
                              onDecrypted={(text) => onDecrypted(msg.id, text)}
                              isMe={isMe}
                              cachedPlaintext={decryptedCache.get(msg.id)}
                              refreshKey={decryptRefreshKey}
                              messageId={msg.id}
                              hasMedia={!!msg.image_url}
                            />
                          </div>
                            );
                          })()}


                          {reactions.length > 0 && (
                            <div className="flex items-center gap-0.5 -mt-1 px-1 relative z-10">
                              <div className="flex items-center gap-1 bg-background border border-border/40 rounded-full px-1.5 py-0.5 shadow-sm">
                                {Object.entries(
                                  reactions.reduce<Record<string, number>>((acc, r) => {
                                    acc[r.emoji] = (acc[r.emoji] || 0) + 1;
                                    return acc;
                                  }, {})
                                ).map(([emoji, count]) => (
                                  <button
                                    key={emoji}
                                    onClick={() => toggleReaction(msg.id, emoji)}
                                    className="flex items-center gap-0.5 text-xs hover:scale-110 transition-transform"
                                  >
                                    <span>{emoji}</span>
                                    {count > 1 && <span className="text-muted-foreground text-[10px]">{count}</span>}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Timestamp + encryption badge */}
                          {isLastInGroup && (
                            <div className="flex items-center gap-1 mt-0.5 px-1">
                              <span className="text-[11px] text-muted-foreground">
                                {format(new Date(msg.created_at), 'HH:mm')}
                              </span>
                              {stableBadgeState.encrypted && looksEncrypted && (
                                <EncryptionBadge
                                  encrypted={true}
                                  verified={decryptedCache.has(msg.id) && stableBadgeState.verified}
                                  ratchetActive={stableBadgeState.ratchetActive}
                                  size="xs"
                                  showLabel
                                />
                              )}
                              {e2ee.encrypted && !looksEncrypted && !isZeusConversation && (
                                <span className="text-[9px] text-muted-foreground/60">non chiffré</span>
                              )}
                              {isMe && (
                                <CheckCheck className="w-3.5 h-3.5 text-primary/70" />
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

            {/* Pending outbound messages from queue (exclude already-sent) */}
            {queue.pendingMessages
              .filter(pm => pm.status !== 'sent')
              .map(pm => (
              <div key={pm.localId} className="flex items-end gap-1.5 mt-2 flex-row-reverse">
                <div className="w-7 flex-shrink-0 mb-0.5" />
                <div className="max-w-[70%] flex flex-col items-end">
                  <div className={cn(
                    'px-3 py-1.5 text-[15px] break-words leading-relaxed rounded-[18px]',
                    'bg-primary/70 text-primary-foreground',
                    (pm.status === 'failed_visible') && 'bg-destructive/20 text-destructive border border-destructive/30',
                  )}>
                    {(() => {
                      const text = pm.plaintext || '';
                      const media = parseMediaMessage(text);
                      if (pm.imageUrl && media) {
                        return (
                          <EncryptedMedia
                            encryptedUrl={pm.imageUrl}
                            mediaKeyB64={media.keyB64}
                            isVideo={isVideoMediaLabel(media.label)}
                          />
                        );
                      }
                      const gif = parseGifMessage(text);
                      if (gif) {
                        const gifUrl = sanitizeUrl(gif);
                        return gifUrl === '#'
                          ? null
                          : <img src={gifUrl} alt="GIF" className="max-w-full max-h-[220px] rounded-[14px] object-cover" />;
                      }
                      const voice = parseVoiceMessage(text);
                      if (voice) {
                        return <VoiceMessagePlayer audioUrl={voice.url} duration={voice.duration} isMe />;
                      }
                      return media?.label || text || '...';
                    })()}
                  </div>
                  <OutboundStatusIndicator
                    status={pm.status}
                    lastError={pm.lastError}
                    onRetry={() => queue.retryMessage(pm.localId)}
                    onRemove={() => queue.removeMessage(pm.localId)}
                  />
                </div>
              </div>
            ))}
          </>
        )}

        {peerTyping && conversation && !conversation.is_group && (
          <TypingIndicator name={conversation.participant.name} />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Scroll to bottom */}
      {showScrollDown && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-28 right-4 z-30 w-9 h-9 rounded-full bg-background shadow-lg border border-border/40 flex items-center justify-center hover:bg-secondary transition-colors"
        >
          <ChevronDown className="w-5 h-5 text-muted-foreground" />
        </button>
      )}

      {/* Reply preview — uses decrypted text */}
      {replyTo && (
        <div className="border-t border-border/30 bg-secondary/30 px-4 py-2 flex items-center gap-3">
          <div className="w-1 h-8 rounded-full bg-primary flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-primary">
              Réponse à {replyTo.sender_id === user?.id ? 'vous-même' : replyTo.profile.name}
            </p>
            <p className="text-xs text-muted-foreground truncate">{getDecryptedText(replyTo)}</p>
          </div>
          <button onClick={() => setReplyTo(null)} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Emoji Picker */}
      {showEmojis && (
        <div className="border-t border-border/30 bg-background">
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
                      className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-secondary active:scale-90 transition-all text-lg"
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

      {/* Share Content Picker */}
      {showSharePicker && (
        <ShareContentPicker
          onShare={(shareText) => {
            queue.sendMessage(shareText).catch(() => toast.error('Erreur'));
            setShowSharePicker(false);
          }}
          onClose={() => setShowSharePicker(false)}
        />
      )}

      {/* Input Bar */}
      <div className="border-t border-border/40 bg-background safe-area-pb">
        {/* Zeus AI helper strip */}
        {!isZeusConversation && newMessage.length > 10 && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/20 bg-accent/30">
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('open-zeus', { detail: { action: 'rewrite', text: newMessage } }))}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-primary/10 text-primary text-[11px] font-medium hover:bg-primary/15 transition-all active:scale-95"
            >
              <Sparkles className="w-3 h-3" />
              Améliorer avec Zeus
            </button>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('open-zeus', { detail: { action: 'translate', text: newMessage } }))}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-secondary/60 text-muted-foreground text-[11px] font-medium hover:bg-secondary hover:text-foreground transition-all active:scale-95"
            >
              Traduire
            </button>
          </div>
        )}
        <form onSubmit={handleSend} className="flex items-center gap-1.5 px-2 py-2">
          <button
            type="button"
            onClick={handleImageUpload}
            disabled={isUploading || sendBlocked}
            className="w-10 h-10 rounded-full flex items-center justify-center text-primary hover:bg-primary/10 transition-colors flex-shrink-0 disabled:opacity-50 disabled:pointer-events-none"
          >
            {isUploading ? (
              <div className="w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            ) : (
              <Camera className="w-6 h-6" />
            )}
          </button>

          <div className="flex-1 flex items-center bg-secondary rounded-full px-1 min-h-[40px]">
            <button
              type="button"
              onClick={() => setShowEmojis(v => !v)}
              className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center transition-colors flex-shrink-0",
                showEmojis ? "text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Smile className="w-5 h-5" />
            </button>
            <input
              ref={inputRef}
              value={newMessage}
              onChange={e => {
                const v = e.target.value;
                setNewMessage(v);
                if (!isZeusConversation) {
                  if (v.trim().length > 0) notifyTyping();
                  else notifyStopped();
                }
              }}
              onBlur={() => { if (!newMessage.trim()) notifyStopped(); }}
              onFocus={() => setShowEmojis(false)}
              placeholder="Aa"
              className="flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground min-w-0 py-2"
            />
          </div>

          {newMessage.trim() ? (
            <button
              type="submit"
              disabled={isSending || sendBlocked}
              className="w-10 h-10 rounded-full flex items-center justify-center text-primary hover:bg-primary/10 transition-colors flex-shrink-0"
            >
              <Send className="w-6 h-6" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setShowVoiceRecorder(true)}
              className="w-10 h-10 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors flex-shrink-0"
            >
              <Mic className="w-5 h-5" />
            </button>
          )}
        </form>

        {/* Voice recorder overlay */}
        {showVoiceRecorder && (
          <VoiceRecorder
            onSend={(audioUrl, dur, encryptedBody) => {
              setShowVoiceRecorder(false);
              const body = encryptedBody || `🎙️ vocal:${audioUrl}|${dur}`;
              queue.sendMessage(body).catch(() => toast.error('Erreur envoi vocal'));
            }}
            onCancel={() => setShowVoiceRecorder(false)}
          />
        )}
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
        isE2eeActive={isE2eeActive}
        localVideoRef={localVideoRef}
        remoteVideoRef={remoteVideoRef}
        onEndCall={handleEndCall}
        onToggleMute={toggleMute}
        onToggleCamera={toggleCamera}
        onSwitchToVideo={switchToVideo}
        onSwitchCamera={switchCamera}
      />

      {/* Forward dialog — uses decrypted text */}
      <ForwardMessageDialog
        open={!!forwardMsg}
        onOpenChange={(v) => { if (!v) setForwardMsg(null); }}
        messageBody={forwardMsg?.plaintext || ''}
        onForward={(targetConvId) => {
          if (forwardMsg) {
            const forwardBody = `↪️ Message transféré:\n"${forwardMsg.plaintext}"`;
            queue.sendMessage(forwardBody).catch(() => toast.error('Erreur'));
            toast.success('Message transféré');
            setForwardMsg(null);
          }
        }}
      />

      {/* New conversation / group dialog */}
      <NewConversationDialog open={showNewChat} onOpenChange={setShowNewChat} />
    </div>
  );
}
