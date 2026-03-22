import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Send, Plus, Smile, Phone, Video,
  Camera, X, CheckCheck, Pin, PinOff, ChevronDown,
  Forward, Users, UserPlus, LogOut, Crown, UserMinus, Sparkles, Info
} from 'lucide-react';
import { format, isSameDay } from 'date-fns';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { useConversations, useMessages, useSendMessage, useMarkConversationRead, useDeleteMessageForMe, useDeleteMessageForEveryone, useLeaveGroup, useAddGroupMembers, useRemoveGroupMember, useGroupMembers, type Message } from '@/hooks/useMessages';
import { useFriendships } from '@/hooks/useFriendships';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useCall } from '@/hooks/useCall';
import { CallOverlay } from '@/components/CallOverlay';
import { useImageUpload } from '@/hooks/useImageUpload';
import { toast } from 'sonner';
import { useE2EE } from '@/hooks/useE2EE';
import { EncryptionBadge, EncryptionStatusBar } from './EncryptionBadge';

import { MessageActions } from './MessageActions';
import { TypingIndicator } from './TypingIndicator';
import { VoiceRecordButton } from './VoiceRecordButton';
import { ForwardMessageDialog } from './ForwardMessageDialog';
import { NewConversationDialog } from './NewConversationDialog';
import { ShareContentPicker } from './ShareContentPicker';
import { EMOJI_CATEGORIES, formatDateSeparator, isSingleEmoji } from './constants';

interface ChatViewProps {
  conversationId: string;
}

export function ChatView({ conversationId }: ChatViewProps) {
  const { user } = useAuth();
  const { data: conversations } = useConversations();
  const { data: messages, isLoading } = useMessages(conversationId);
  const sendMessage = useSendMessage();
  const deleteForMe = useDeleteMessageForMe();
  const deleteForEveryone = useDeleteMessageForEveryone();
  const markRead = useMarkConversationRead();
  const [newMessage, setNewMessage] = useState('');
  const [showEmojis, setShowEmojis] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [messageReactions, setMessageReactions] = useState<Record<string, string[]>>({});
  const [isTyping, setIsTyping] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [showSharePicker, setShowSharePicker] = useState(false);
  const [pinnedMessages, setPinnedMessages] = useState<Set<string>>(new Set());
  const [forwardMsg, setForwardMsg] = useState<Message | null>(null);
  const [showGroupPanel, setShowGroupPanel] = useState(false);
  const [showInvitePanel, setShowInvitePanel] = useState(false);
  const [inviteSearch, setInviteSearch] = useState('');
  const [showNewChat, setShowNewChat] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
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
  const e2ee = useE2EE(conversationId, peerUserId);

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

  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    setShowScrollDown(scrollHeight - scrollTop - clientHeight > 200);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim()) return;

    let body = replyTo
      ? `↩️ ${replyTo.profile.name}: "${replyTo.body.slice(0, 50)}${replyTo.body.length > 50 ? '…' : ''}"\n\n${newMessage.trim()}`
      : newMessage.trim();

    // E2EE: encrypt before sending
    if (e2ee.encrypted) {
      body = await e2ee.encrypt(body);
    }

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
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />

      {/* Facebook Messenger-style header */}
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
                  <span className="text-[15px] font-semibold block truncate leading-tight">{conversation.participant.name}</span>
                  <span className="text-[11px] text-emerald-600 dark:text-emerald-400 leading-tight">Actif(ve) maintenant</span>
                </div>
              </Link>
            )
          )}

          {/* Action buttons - Facebook Messenger style */}
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full text-primary"
              onClick={() => startCall(conversationId, 'audio')}
              disabled={callState !== 'idle'}
            >
              <Phone className="w-5 h-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full text-primary"
              onClick={() => startCall(conversationId, 'video')}
              disabled={callState !== 'idle'}
            >
              <Video className="w-5 h-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full text-primary"
              onClick={() => setShowGroupPanel(!showGroupPanel)}
            >
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
      />

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
                📌 {pinned.length === 1 ? pinned[0].body.slice(0, 60) : `${pinned.length} messages épinglés`}
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

      {/* Messages area - Facebook Messenger style */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-4 relative"
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          </div>
        ) : messages?.length === 0 ? (
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
                    let body = suggestion;
                    if (e2ee.encrypted) {
                      body = await e2ee.encrypt(body);
                    }
                    sendMessage.mutate({ conversationId, body });
                  }}
                  className="px-4 py-2 rounded-full bg-primary/10 text-primary text-sm font-medium hover:bg-primary/20 active:scale-95 transition-all"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          groupedMessages.map((group, gi) => (
            <div key={gi}>
              {/* Date separator - clean Facebook style */}
              <div className="flex items-center justify-center my-4">
                <span className="text-[11px] font-medium text-muted-foreground px-3 py-1 rounded-full bg-secondary/60 capitalize">
                  {formatDateSeparator(group.date)}
                </span>
              </div>

              {/* Messages */}
              <div className="space-y-0.5">
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
                        'flex items-end gap-1.5 relative group',
                        isFirstInGroup ? 'mt-2' : 'mt-px'
                      )}
                    >
                      {/* Avatar for all senders */}
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
                          onCopy={() => handleCopy(msg.body)}
                          onForward={() => setForwardMsg(msg)}
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
                            await supabase.from('abuse_reports').insert({
                              reporter_id: user!.id,
                              reported_user_id: msg.sender_id,
                              report_type: 'message',
                              description: `Message signalé: "${msg.body.slice(0, 200)}"`,
                            });
                            toast.success('Message signalé. Merci pour votre vigilance.');
                          }}
                        />

                        {/* Pin indicator */}
                        {pinnedMessages.has(msg.id) && (
                          <div className="flex items-center gap-1 mb-0.5">
                            <Pin className="w-3 h-3 text-primary" />
                            <span className="text-[10px] text-primary font-medium">Épinglé</span>
                          </div>
                        )}

                        {/* Image message */}
                        {isImage && (
                          <div className="overflow-hidden mb-0.5 rounded-[18px] rounded-bl-sm">
                            <img src={msg.image_url!} alt="Photo" className="max-w-full max-h-[300px] object-cover" />
                          </div>
                        )}

                        {/* Message bubble */}
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
                          {msg.body}
                        </div>

                        {/* Reactions */}
                        {reactions.length > 0 && (
                          <div className="flex items-center gap-0.5 -mt-1 px-1 relative z-10">
                            <div className="flex items-center gap-0 bg-background border border-border/40 rounded-full px-1.5 py-0.5 shadow-sm">
                              {reactions.map((r, i) => (
                                <span key={i} className="text-xs">{r}</span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Timestamp + read receipt + encryption badge */}
                        {isLastInGroup && (
                          <div className="flex items-center gap-1 mt-0.5 px-1">
                            <span className="text-[11px] text-muted-foreground">
                              {format(new Date(msg.created_at), 'HH:mm')}
                            </span>
                            {e2ee.encrypted && (
                              <EncryptionBadge encrypted={true} verified={true} size="xs" />
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
          ))
        )}

        {isTyping && conversation && (
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

      {/* Reply preview */}
      {replyTo && (
        <div className="border-t border-border/30 bg-secondary/30 px-4 py-2 flex items-center gap-3">
          <div className="w-1 h-8 rounded-full bg-primary flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-primary">
              Réponse à {replyTo.sender_id === user?.id ? 'vous-même' : replyTo.profile.name}
            </p>
            <p className="text-xs text-muted-foreground truncate">{replyTo.body}</p>
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
            sendMessage.mutate({ conversationId, body: shareText });
            setShowSharePicker(false);
          }}
          onClose={() => setShowSharePicker(false)}
        />
      )}

      {/* Input Bar - Facebook Messenger style */}
      <div className="border-t border-border/40 bg-background safe-area-pb">
        <form onSubmit={handleSend} className="flex items-center gap-1.5 px-2 py-2">
          {/* Quick actions */}
          <button
            type="button"
            onClick={handleImageUpload}
            disabled={isUploading}
            className="w-10 h-10 rounded-full flex items-center justify-center text-primary hover:bg-primary/10 transition-colors flex-shrink-0"
          >
            {isUploading ? (
              <div className="w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            ) : (
              <Camera className="w-6 h-6" />
            )}
          </button>

          {/* Input field */}
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
              onChange={e => setNewMessage(e.target.value)}
              onFocus={() => setShowEmojis(false)}
              placeholder="Aa"
              className="flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground min-w-0 py-2"
            />
          </div>

          {/* Send or Voice */}
          {newMessage.trim() ? (
            <button
              type="submit"
              disabled={sendMessage.isPending}
              className="w-10 h-10 rounded-full flex items-center justify-center text-primary hover:bg-primary/10 transition-colors flex-shrink-0"
            >
              <Send className="w-6 h-6" />
            </button>
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

      {/* Forward dialog */}
      <ForwardMessageDialog
        open={!!forwardMsg}
        onOpenChange={(v) => { if (!v) setForwardMsg(null); }}
        messageBody={forwardMsg?.body || ''}
        onForward={(targetConvId) => {
          if (forwardMsg) {
            const forwardBody = `↪️ Message transféré:\n"${forwardMsg.body}"`;
            sendMessage.mutate({ conversationId: targetConvId, body: forwardBody });
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
