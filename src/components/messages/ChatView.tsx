import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Send, Plus, Smile, Phone, Video,
  Camera, X, CheckCheck, Pin, PinOff, ChevronDown,
  Forward, Users, UserPlus, LogOut, Crown, UserMinus, Sparkles
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
            conversation.is_group ? (
              <button onClick={() => setShowGroupPanel(!showGroupPanel)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary/20 to-accent/30 flex items-center justify-center text-lg flex-shrink-0">
                  👥
                </div>
                <div className="min-w-0">
                  <span className="text-sm font-semibold block truncate">{conversation.name || 'Groupe'}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {groupMembers.length} membres · Appuyez pour gérer
                  </span>
                </div>
              </button>
            ) : (
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
            )
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
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full text-primary hover:bg-primary/10"
              onClick={() => setShowNewChat(true)}
              title="Nouveau message / groupe"
            >
              <Plus className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>

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

            {/* Members list */}
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

            {/* Invite friends panel */}
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

      {(() => {
        const pinned = messages?.filter(m => pinnedMessages.has(m.id)) || [];
        if (pinned.length === 0) return null;
        return (
          <div className="sticky top-14 z-30 glass border-b border-border/20 px-4 py-2 animate-in slide-in-from-top-2">
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
                        <Link to={`/profile/${msg.sender_id}`} className="w-7 flex-shrink-0">
                          {isLastInGroup && (
                            <UserAvatar src={msg.profile.avatar_url} alt={msg.profile.name} size="xs" />
                          )}
                        </Link>
                      )}

                      <div className={cn('max-w-[75%] flex flex-col relative', isMe ? 'items-end' : 'items-start')}>
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
                          <div className={cn("flex items-center gap-1 mb-0.5", isMe ? "flex-row-reverse" : "")}>
                            <Pin className="w-3 h-3 text-primary" />
                            <span className="text-[10px] text-primary font-medium">Épinglé</span>
                          </div>
                        )}

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
            <button
              type="button"
              onClick={() => setShowSharePicker(v => !v)}
              className={cn(
                "w-9 h-9 rounded-full flex items-center justify-center transition-all",
                showSharePicker ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-primary hover:bg-primary/10"
              )}
            >
              <Forward className="w-5 h-5" />
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
