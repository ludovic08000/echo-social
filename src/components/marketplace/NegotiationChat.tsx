import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useAuth } from '@/lib/auth';
import { useMessages, useSendMessage, useCreateConversation, useConversations } from '@/hooks/useMessages';
import { useNegotiations, useCreateNegotiation, useRespondNegotiation, useAcceptCounterOffer, type Negotiation } from '@/hooks/useNegotiations';
import { supabase } from '@/integrations/supabase/client';
import { trackAICall } from '@/lib/ml/aiEngine';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Send, X, ArrowLeft, Wand2, Languages, SpellCheck, PenLine, Sparkles, Tag, Check, XIcon, ArrowRightLeft, CreditCard } from 'lucide-react';
import { format, isToday, isYesterday, isSameDay } from 'date-fns';
import { fr } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

function formatTime(d: string) {
  const date = new Date(d);
  if (isToday(date)) return format(date, 'HH:mm');
  if (isYesterday(date)) return 'Hier';
  return format(date, 'dd/MM/yy');
}

const URL_REGEX = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/;
const URL_REGEX_G = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g;

function MsgBody({ body, isMe }: { body: string; isMe: boolean }) {
  if (!URL_REGEX.test(body)) return <>{body}</>;
  const parts = body.split(URL_REGEX_G);
  return <>{parts.map((p, i) => URL_REGEX.test(p) ? (
    <a key={i} href={sanitizeUrl(p)} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
      className={cn('underline break-all', isMe ? 'text-primary-foreground/90' : 'text-primary')}>
      {p.length > 40 ? p.slice(0, 37) + '…' : p}
    </a>
  ) : <span key={i}>{p}</span>)}</>;
}

interface NegotiationChatProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  product: {
    id: string;
    title: string;
    price: number;
    thumbnail_url?: string;
    seller_profiles?: { id: string; store_name: string; user_id?: string; store_logo_url?: string };
  };
}

export function NegotiationChat({ open, onOpenChange, product }: NegotiationChatProps) {
  const { user } = useAuth();
  const seller = product.seller_profiles;
  const sellerUserId = (seller as any)?.user_id;

  // Find or create conversation
  const { data: conversations } = useConversations();
  const createConversation = useCreateConversation();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !sellerUserId || !user || !conversations) return;
    const existing = conversations.find(c => c.participant.user_id === sellerUserId);
    if (existing) {
      setConversationId(existing.id);
    }
  }, [open, sellerUserId, user, conversations]);

  const initConversation = async () => {
    if (conversationId || !sellerUserId) return conversationId;
    setLoading(true);
    try {
      const conv = await createConversation.mutateAsync(sellerUserId);
      setConversationId(conv.id);
      return conv.id;
    } catch { toast.error('Erreur création conversation'); return null; }
    finally { setLoading(false); }
  };

  // Messages
  const { data: messages = [], isLoading: msgsLoading } = useMessages(conversationId || '');
  const sendMessage = useSendMessage();
  const [newMessage, setNewMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // AI
  const [showAIMenu, setShowAIMenu] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);

  // Negotiation
  const { data: negotiations = [] } = useNegotiations(product.id);
  const createNeg = useCreateNegotiation();
  const respondNeg = useRespondNegotiation();
  const acceptCounter = useAcceptCounterOffer();
  const [showOfferInput, setShowOfferInput] = useState(false);
  const [offerPrice, setOfferPrice] = useState('');

  const myNegotiation = useMemo(() =>
    negotiations.find(n => n.buyer_id === user?.id && ['pending', 'counter'].includes(n.status)),
    [negotiations, user]
  );
  const acceptedNeg = useMemo(() =>
    negotiations.find(n => n.buyer_id === user?.id && n.status === 'accepted'),
    [negotiations, user]
  );
  // For seller view
  const pendingForSeller = useMemo(() =>
    negotiations.filter(n => n.status === 'pending' || n.status === 'counter'),
    [negotiations]
  );
  const isSeller = seller && (seller as any).user_id === user?.id;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim()) return;
    let cId = conversationId;
    if (!cId) cId = await initConversation();
    if (!cId) return;
    sendMessage.mutate({ conversationId: cId, body: newMessage.trim() }, {
      onSuccess: () => setNewMessage(''),
    });
  };

  const handleAI = async (action: 'correct' | 'improve' | 'translate', tone?: string) => {
    if (!newMessage.trim() || aiLoading) return;
    setAiLoading(true); setShowAIMenu(false);
    const start = performance.now();
    try {
      const reqBody: Record<string, string> = { action, text: newMessage.trim() };
      if (action === 'translate') reqBody.targetLanguage = 'en';
      if (tone) reqBody.tone = tone;
      const { data, error } = await supabase.functions.invoke('zeus', { body: { domain: 'content', ...reqBody } });
      trackAICall(`nego-${action}`, Math.round(performance.now() - start), !error && !data?.error);
      if (error || data?.error) { toast.error(data?.error || 'Erreur IA'); return; }
      if (data?.result) setAiSuggestion(data.result);
    } catch { toast.error('Erreur IA'); } finally { setAiLoading(false); }
  };

  const handleMakeOffer = async () => {
    const price = parseFloat(offerPrice);
    if (isNaN(price) || price <= 0) { toast.error('Prix invalide'); return; }
    if (price >= product.price) { toast.error('Votre offre doit être inférieure au prix affiché'); return; }
    if (!seller) return;
    let cId = conversationId;
    if (!cId) cId = await initConversation();
    createNeg.mutate({
      productId: product.id,
      sellerProfileId: seller.id,
      originalPrice: product.price,
      offeredPrice: price,
      conversationId: cId || undefined,
    }, {
      onSuccess: () => {
        setShowOfferInput(false);
        setOfferPrice('');
        if (cId) {
          sendMessage.mutate({ conversationId: cId, body: `💰 OFFRE: ${price.toFixed(2)} € pour "${product.title}" (prix: ${product.price.toFixed(2)} €)` });
        }
      },
    });
  };

  const handleSellerRespond = (neg: Negotiation, action: 'accepted' | 'rejected') => {
    respondNeg.mutate({ negotiationId: neg.id, action }, {
      onSuccess: () => {
        if (conversationId) {
          const msg = action === 'accepted'
            ? `✅ OFFRE ACCEPTÉE: ${neg.offered_price.toFixed(2)} € pour "${product.title}"`
            : `❌ OFFRE REFUSÉE pour "${product.title}"`;
          sendMessage.mutate({ conversationId, body: msg });
        }
      },
    });
  };

  const handleCounterOffer = (neg: Negotiation, counterPrice: number) => {
    respondNeg.mutate({ negotiationId: neg.id, action: 'counter', counterPrice }, {
      onSuccess: () => {
        if (conversationId) {
          sendMessage.mutate({ conversationId, body: `🔄 CONTRE-OFFRE: ${counterPrice.toFixed(2)} € pour "${product.title}"` });
        }
      },
    });
  };

  const handlePayNegotiated = async () => {
    if (!acceptedNeg) return;
    try {
      const { data, error } = await supabase.functions.invoke('marketplace-checkout', {
        body: {
          action: 'negotiation_checkout',
          negotiationId: acceptedNeg.id,
        },
      });
      if (error || data?.error) throw new Error(data?.error || 'Erreur');
      if (data?.url) window.location.href = data.url;
    } catch (e: any) { toast.error(e.message || 'Erreur paiement'); }
  };

  // Counter price input for seller
  const [counterInput, setCounterInput] = useState<string>('');
  const [counterNegId, setCounterNegId] = useState<string | null>(null);

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] flex flex-col p-0 gap-0 rounded-2xl overflow-hidden" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Négociation - {product.title}</DialogTitle>
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 bg-primary text-primary-foreground">
          <button onClick={() => onOpenChange(false)}>
            <X className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {product.thumbnail_url && (
              <img src={product.thumbnail_url} className="w-8 h-8 rounded-lg object-cover" alt="" />
            )}
            <div className="min-w-0">
              <p className="text-xs font-bold truncate">{product.title}</p>
              <p className="text-[10px] opacity-80">{seller?.store_name} · {product.price.toFixed(2)} €</p>
            </div>
          </div>
        </div>

        {/* Negotiation status bar */}
        {myNegotiation && !isSeller && (
          <div className={cn('px-4 py-2 text-xs flex items-center gap-2 border-b border-border/30',
            myNegotiation.status === 'counter' ? 'bg-amber-500/10' : 'bg-primary/5'
          )}>
            <Tag className="w-3.5 h-3.5 text-primary" />
            {myNegotiation.status === 'pending' && (
              <span>Votre offre de <b>{myNegotiation.offered_price.toFixed(2)} €</b> est en attente</span>
            )}
            {myNegotiation.status === 'counter' && (
              <div className="flex items-center gap-2 flex-1">
                <span>Contre-offre: <b>{myNegotiation.counter_price?.toFixed(2)} €</b></span>
                <div className="flex gap-1 ml-auto">
                  <Button size="sm" variant="default" className="h-6 text-[10px] rounded-full px-2"
                    onClick={() => acceptCounter.mutate({ negotiationId: myNegotiation.id }, {
                      onSuccess: () => {
                        if (conversationId) {
                          sendMessage.mutate({ conversationId, body: `✅ CONTRE-OFFRE ACCEPTÉE: ${myNegotiation.counter_price?.toFixed(2)} €` });
                        }
                      }
                    })}>
                    <Check className="w-3 h-3 mr-0.5" /> Accepter
                  </Button>
                  <Button size="sm" variant="outline" className="h-6 text-[10px] rounded-full px-2"
                    onClick={() => respondNeg.mutate({ negotiationId: myNegotiation.id, action: 'rejected' })}>
                    <XIcon className="w-3 h-3 mr-0.5" /> Refuser
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Accepted negotiation - Pay button */}
        {acceptedNeg && !isSeller && (
          <div className="px-4 py-3 bg-emerald-500/10 border-b border-border/30 flex items-center gap-2">
            <Check className="w-4 h-4 text-emerald-600" />
            <span className="text-xs font-semibold text-emerald-700 flex-1">
              Prix négocié: <b>{acceptedNeg.offered_price.toFixed(2)} €</b>
            </span>
            <Button size="sm" className="h-8 rounded-xl text-xs gap-1 premium-button" onClick={handlePayNegotiated}>
              <CreditCard className="w-3.5 h-3.5" /> Payer
            </Button>
          </div>
        )}

        {/* Seller: pending offers */}
        {isSeller && pendingForSeller.length > 0 && (
          <div className="px-4 py-2 border-b border-border/30 space-y-2">
            {pendingForSeller.map(neg => (
              <div key={neg.id} className="bg-amber-500/10 rounded-xl p-2.5 text-xs">
                <p className="font-semibold mb-1.5">
                  {neg.status === 'pending'
                    ? `💰 Offre reçue: ${neg.offered_price.toFixed(2)} € (prix: ${neg.original_price.toFixed(2)} €)`
                    : `🔄 En attente de réponse à votre contre-offre de ${neg.counter_price?.toFixed(2)} €`
                  }
                </p>
                {neg.status === 'pending' && (
                  <div className="flex gap-1.5">
                    <Button size="sm" className="h-6 text-[10px] rounded-full px-2.5"
                      onClick={() => handleSellerRespond(neg, 'accepted')}>
                      <Check className="w-3 h-3 mr-0.5" /> Accepter
                    </Button>
                    <Button size="sm" variant="outline" className="h-6 text-[10px] rounded-full px-2.5"
                      onClick={() => setCounterNegId(neg.id)}>
                      <ArrowRightLeft className="w-3 h-3 mr-0.5" /> Contre-offre
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 text-[10px] rounded-full px-2.5 text-destructive"
                      onClick={() => handleSellerRespond(neg, 'rejected')}>
                      <XIcon className="w-3 h-3 mr-0.5" /> Refuser
                    </Button>
                  </div>
                )}
                {counterNegId === neg.id && (
                  <div className="flex gap-1.5 mt-2">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={counterInput}
                      onChange={e => setCounterInput(e.target.value)}
                      placeholder="Votre prix"
                      className="h-7 text-xs rounded-lg flex-1"
                    />
                    <Button size="sm" className="h-7 text-[10px] rounded-lg"
                      onClick={() => {
                        const p = parseFloat(counterInput);
                        if (isNaN(p) || p <= 0) return;
                        handleCounterOffer(neg, p);
                        setCounterNegId(null);
                        setCounterInput('');
                      }}>
                      Envoyer
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1 min-h-0">
          {msgsLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-6 h-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 gap-2 text-center">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                <Tag className="w-5 h-5 text-primary" />
              </div>
              <p className="text-xs text-muted-foreground">Discutez avec le vendeur et négociez le prix</p>
            </div>
          ) : (
            messages.map((msg: any) => {
              const isMe = msg.sender_id === user?.id;
              const isOffer = msg.body.startsWith('💰 OFFRE:') || msg.body.startsWith('✅ OFFRE') || msg.body.startsWith('❌ OFFRE') || msg.body.startsWith('🔄 CONTRE') || msg.body.startsWith('✅ CONTRE');
              return (
                <div key={msg.id} className={cn('flex gap-1.5', isMe ? 'flex-row-reverse' : '')}>
                  {!isMe && <UserAvatar src={msg.profile?.avatar_url} alt={msg.profile?.name} size="xs" />}
                  <div className={cn(
                    'max-w-[80%] px-3 py-1.5 text-xs rounded-2xl break-words',
                    isOffer
                      ? 'bg-amber-500/10 border border-amber-500/30 text-foreground'
                      : isMe
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary'
                  )}>
                    <MsgBody body={msg.body} isMe={isMe && !isOffer} />
                  </div>
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* AI suggestion */}
        {aiSuggestion && (
          <div className="mx-3 mb-1 bg-primary/5 border border-primary/20 rounded-xl px-3 py-2">
            <div className="flex items-center gap-1.5 mb-1">
              <Wand2 className="w-3 h-3 text-primary" />
              <span className="text-[9px] font-semibold text-primary">Suggestion IA</span>
            </div>
            <p className="text-xs leading-relaxed mb-2">{aiSuggestion}</p>
            <div className="flex gap-1.5">
              <button onClick={() => { setNewMessage(aiSuggestion); setAiSuggestion(null); }}
                className="px-2.5 py-1 rounded-full bg-primary text-primary-foreground text-[10px] font-medium">✓ Utiliser</button>
              <button onClick={() => setAiSuggestion(null)}
                className="px-2.5 py-1 rounded-full bg-secondary text-[10px] font-medium">✗ Ignorer</button>
            </div>
          </div>
        )}

        {/* AI menu */}
        {showAIMenu && (
          <div className="mx-3 mb-1 bg-background border border-border/40 rounded-xl shadow-lg overflow-hidden">
            <div className="p-1.5 grid grid-cols-2 gap-1">
              {[
                { action: 'correct' as const, icon: SpellCheck, label: 'Corriger', sub: 'Orthographe' },
                { action: 'improve' as const, icon: PenLine, label: 'Améliorer', sub: 'Style', tone: 'friendly' },
                { action: 'translate' as const, icon: Languages, label: 'Traduire', sub: 'Auto' },
                { action: 'improve' as const, icon: Sparkles, label: 'Formel', sub: 'Ton pro', tone: 'formal' },
              ].map((item, i) => (
                <button key={i} type="button" onClick={() => handleAI(item.action, item.tone)}
                  disabled={!newMessage.trim()}
                  className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg hover:bg-secondary/80 transition-colors text-left disabled:opacity-40">
                  <item.icon className="w-3.5 h-3.5 text-primary" />
                  <div>
                    <p className="text-[10px] font-semibold">{item.label}</p>
                    <p className="text-[8px] text-muted-foreground">{item.sub}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Offer input */}
        {showOfferInput && (
          <div className="mx-3 mb-1 bg-amber-500/5 border border-amber-500/30 rounded-xl p-3">
            <p className="text-xs font-semibold mb-2">💰 Faire une offre</p>
            <div className="flex gap-2">
              <Input
                type="number"
                step="0.01"
                min="0"
                max={product.price}
                value={offerPrice}
                onChange={e => setOfferPrice(e.target.value)}
                placeholder={`Max ${product.price.toFixed(2)} €`}
                className="h-8 text-xs rounded-lg flex-1"
                autoFocus
              />
              <Button size="sm" className="h-8 rounded-lg text-xs" onClick={handleMakeOffer}
                disabled={createNeg.isPending}>
                Envoyer
              </Button>
              <Button size="sm" variant="ghost" className="h-8 rounded-lg text-xs px-2"
                onClick={() => setShowOfferInput(false)}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        )}

        {/* Input bar */}
        <div className="border-t border-border/30 bg-background">
          <form onSubmit={handleSend} className="flex items-center gap-1 px-2 py-1.5">
            <div className="flex items-center gap-0">
              {!isSeller && !myNegotiation && !acceptedNeg && (
                <button type="button" onClick={() => setShowOfferInput(!showOfferInput)}
                  className={cn("w-7 h-7 rounded-full flex items-center justify-center transition-colors",
                    showOfferInput ? "text-primary" : "text-muted-foreground hover:text-primary")}>
                  <Tag className="w-4 h-4" />
                </button>
              )}
              <button type="button" onClick={() => { setShowAIMenu(v => !v); }}
                className={cn("w-7 h-7 rounded-full flex items-center justify-center transition-colors",
                  showAIMenu ? "text-primary" : "text-muted-foreground hover:text-primary")}>
                {aiLoading ? <div className="w-3.5 h-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin" /> : <Wand2 className="w-4 h-4" />}
              </button>
            </div>
            <input
              value={newMessage}
              onChange={e => setNewMessage(e.target.value)}
              onFocus={() => setShowAIMenu(false)}
              placeholder="Discuter..."
              className="flex-1 bg-secondary/60 rounded-full px-3 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:bg-secondary transition-colors min-w-0"
            />
            {newMessage.trim() && (
              <button type="submit" disabled={sendMessage.isPending || loading}
                className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center flex-shrink-0">
                <Send className="w-3.5 h-3.5" />
              </button>
            )}
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
