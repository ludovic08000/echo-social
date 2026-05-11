import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Send, Loader2, Pencil, Check, Zap, AlertTriangle, CheckCircle2,
  Plus, History, ArrowLeft, ShoppingBag, Sliders, Brain, Users, Clock,
  Sparkles, ChevronRight, BarChart3, Radio, Cpu, Shield, Globe, MessageSquare,
  Search
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useZeusSettings, useZeusAgentId, useContentStrikes } from '@/hooks/useZeusCompanion';
import { useZeusConversations, useZeusMessages } from '@/hooks/useZeusConversations';
import { useSendMessage } from '@/hooks/useMessages';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { SafeMarkdown } from '@/components/SafeMarkdown';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { loadFeedWeights, type FeedWeights } from '@/lib/feedAlgorithm';
import { saveFeedPrefs } from '@/lib/feedPreferences';


type Msg = { role: string; content: string };
type ActiveTab = 'chat' | 'algo' | 'history';
type FeedAlgorithm = 'smart' | 'chronological' | 'friends_first';

interface ActionBlock {
  type: 'publish_post' | 'schedule_post' | 'create_story' | 'generate_image' | 'translate' | 'update_feed_config' | 'send_message';
  body?: string;
  caption?: string;
  publish_at?: string;
  image_prompt?: string | null;
  prompt?: string;
  target_language?: string;
  translated_text?: string;
  conversation_id?: string;
  recipient_name?: string;
  message_text?: string;
}

interface ProductItem {
  id: string;
  title: string;
  price: number;
  thumbnail_url?: string;
  city?: string;
  condition?: string;
}

function parseProductsFromContent(content: string): { text: string; products: ProductItem[] | null } {
  const patterns = [/```forsure-products\s*\n([\s\S]*?)\n```/, /```forsure-products\s*([\s\S]*?)```/];
  for (const regex of patterns) {
    const match = content.match(regex);
    if (match) {
      try {
        const products = JSON.parse(match[1].trim());
        return { text: content.replace(match[0], '').trim(), products: Array.isArray(products) ? products : null };
      } catch { /* ignore */ }
    }
  }
  return { text: content, products: null };
}

function parseActionFromContent(content: string): { text: string; action: ActionBlock | null } {
  const patterns = [/```forsure-action\s*\n([\s\S]*?)\n```/, /```forsure-action\s*([\s\S]*?)```/];
  for (const regex of patterns) {
    const match = content.match(regex);
    if (match) {
      try {
        const action = JSON.parse(match[1].trim());
        return { text: content.replace(match[0], '').trim(), action };
      } catch { /* ignore */ }
    }
  }
  return { text: content, action: null };
}

function stripCodeBlocks(text: string): string {
  return text
    .replace(/```json\s*[\s\S]*?```/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim();
}

// ── Product cards ──
function ProductCards({ products, onNavigate }: { products: ProductItem[]; onNavigate: (id: string) => void }) {
  return (
    <div className="mt-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5 mb-1">
        <ShoppingBag className="w-3.5 h-3.5 text-primary" />
        <span className="text-[10px] font-semibold text-primary uppercase tracking-wider">Marketplace</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {products.slice(0, 6).map((p) => (
          <button key={p.id} onClick={() => onNavigate(p.id)}
            className="rounded-xl border border-border bg-card overflow-hidden hover:border-primary/30 transition-all text-left group hover:shadow-md">
            {p.thumbnail_url ? (
              <div className="aspect-square w-full overflow-hidden bg-muted">
                <img src={p.thumbnail_url} alt={p.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
              </div>
            ) : (
              <div className="aspect-square w-full bg-muted flex items-center justify-center">
                <ShoppingBag className="w-6 h-6 text-muted-foreground/30" />
              </div>
            )}
            <div className="p-1.5">
              <p className="text-[10px] font-medium text-card-foreground truncate">{p.title}</p>
              <div className="flex items-center justify-between mt-0.5">
                <span className="text-xs font-bold text-primary">{p.price}€</span>
                {p.city && <span className="text-[9px] text-muted-foreground truncate ml-1">{p.city}</span>}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Action card ──
function ActionCard({ action, onExecute, executing, executed }: {
  action: ActionBlock; onExecute: () => void; executing: boolean; executed: boolean;
}) {
  const labels: Record<string, { icon: React.ReactNode; label: string }> = {
    publish_post: { icon: <Send className="w-3.5 h-3.5" />, label: 'Publier ce post' },
    schedule_post: { icon: <Clock className="w-3.5 h-3.5" />, label: 'Programmer ce post' },
    create_story: { icon: <Sparkles className="w-3.5 h-3.5" />, label: 'Créer cette story' },
    generate_image: { icon: <Sparkles className="w-3.5 h-3.5" />, label: 'Générer image' },
    translate: { icon: <Globe className="w-3.5 h-3.5" />, label: 'Traduction' },
    update_feed_config: { icon: <Sliders className="w-3.5 h-3.5" />, label: 'Ajuster algorithme' },
    send_message: { icon: <MessageSquare className="w-3.5 h-3.5" />, label: `Envoyer à ${action.recipient_name || 'un ami'}` },
  };
  const info = labels[action.type] || { icon: <Zap className="w-3.5 h-3.5" />, label: 'Action' };
  const preview = action.type === 'update_feed_config' ? '' : (action.message_text || action.body || action.caption || action.translated_text || action.prompt || '');

  return (
    <div className="mt-2.5 p-3 rounded-xl bg-accent/50 border border-border space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="text-primary">{info.icon}</span>
        <span className="text-[11px] font-semibold text-primary">{info.label}</span>
        {action.publish_at && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {new Date(action.publish_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}
          </span>
        )}
      </div>
      {preview && <p className="text-xs text-foreground/80 bg-muted rounded-lg p-2.5 whitespace-pre-wrap leading-relaxed border border-border text-[11px]">{preview}</p>}
      {executed ? (
        <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
          <CheckCircle2 className="w-3.5 h-3.5" /><span>Exécuté ✓</span>
        </div>
      ) : (
        <Button size="sm" onClick={onExecute} disabled={executing}
          className="w-full h-8 text-[11px] rounded-xl">
          {executing ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
          {executing ? 'En cours...' : 'Confirmer'}
        </Button>
      )}
    </div>
  );
}

// ── Feed Preview ──
function FeedPreviewBar({ friends, discovery, marketplace, algo, viralReduce, diversityBoost }: {
  friends: number; discovery: number; marketplace: number; algo: FeedAlgorithm; viralReduce: boolean; diversityBoost: number;
}) {
  const total = Math.max(1, friends + discovery + marketplace);
  const fPct = Math.round((friends / total) * 100);
  const dPct = Math.round((discovery / total) * 100);
  const mPct = 100 - fPct - dPct;

  const posts = Array.from({ length: 10 }, (_, i) => {
    const rand = Math.random() * 100;
    if (algo === 'chronological') return 'chrono';
    if (algo === 'friends_first') return i < 7 ? 'friend' : rand < 50 ? 'discovery' : 'marketplace';
    if (rand < fPct) return 'friend';
    if (rand < fPct + dPct) return 'discovery';
    return 'marketplace';
  });

  const colors: Record<string, string> = {
    friend: 'bg-primary', discovery: 'bg-violet-500', marketplace: 'bg-amber-500', chrono: 'bg-primary/60',
  };

  return (
    <div className="space-y-2 p-3 rounded-xl bg-muted/50 border border-border">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Aperçu du flux</span>
        <motion.span animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 2, repeat: Infinity }}
          className="text-[9px] text-primary flex items-center gap-1">
          <Radio className="w-2.5 h-2.5" /> En direct
        </motion.span>
      </div>
      <div className="flex gap-px h-8 rounded-lg overflow-hidden border border-border">
        <motion.div animate={{ width: `${fPct}%` }} transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className="bg-primary/30 flex items-center justify-center min-w-0" title={`Amis: ${fPct}%`}>
          {fPct > 15 && <span className="text-[8px] text-primary-foreground font-bold">{fPct}%</span>}
        </motion.div>
        <motion.div animate={{ width: `${dPct}%` }} transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className="bg-violet-500/30 flex items-center justify-center min-w-0" title={`Découverte: ${dPct}%`}>
          {dPct > 15 && <span className="text-[8px] font-bold text-violet-700 dark:text-violet-200">{dPct}%</span>}
        </motion.div>
        <motion.div animate={{ width: `${mPct}%` }} transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className="bg-amber-500/30 flex items-center justify-center min-w-0" title={`Marketplace: ${mPct}%`}>
          {mPct > 15 && <span className="text-[8px] font-bold text-amber-700 dark:text-amber-200">{mPct}%</span>}
        </motion.div>
      </div>
      <div className="flex gap-1 justify-center">
        {posts.map((type, i) => (
          <motion.div key={i} layout initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 0.8 }}
            transition={{ delay: i * 0.04, type: 'spring' }}
            className={cn("w-3 h-4 rounded-sm", colors[type])} />
        ))}
      </div>
      <div className="flex gap-3 justify-center">
        <span className="flex items-center gap-1 text-[8px] text-muted-foreground"><span className="w-2 h-2 rounded-sm bg-primary inline-block" /> Amis</span>
        <span className="flex items-center gap-1 text-[8px] text-muted-foreground"><span className="w-2 h-2 rounded-sm bg-violet-500 inline-block" /> Découverte</span>
        <span className="flex items-center gap-1 text-[8px] text-muted-foreground"><span className="w-2 h-2 rounded-sm bg-amber-500 inline-block" /> Market</span>
      </div>
    </div>
  );
}

// ── Algorithm Control Panel ──
function AlgorithmPanel() {
  const queryClient = useQueryClient();
  const [feedAlgo, setFeedAlgo] = useState<FeedAlgorithm>(() => {
    try { return JSON.parse(localStorage.getItem('content-prefs') || '{}').feedAlgorithm || 'smart'; } catch { return 'smart'; }
  });
  const [feedWeights, setFeedWeights] = useState<FeedWeights>(loadFeedWeights);
  const [diversityBoost, setDiversityBoost] = useState<number>(() => {
    try { return JSON.parse(localStorage.getItem('content-prefs') || '{}').diversityBoost ?? 50; } catch { return 50; }
  });
  const [viralReduce, setViralReduce] = useState<boolean>(() => {
    try { return JSON.parse(localStorage.getItem('content-prefs') || '{}').viralContentReduce ?? false; } catch { return false; }
  });
  const [lastChanged, setLastChanged] = useState<string | null>(null);

  const savePrefs = useCallback((patch: Record<string, any>) => {
    try {
      const prev = JSON.parse(localStorage.getItem('content-prefs') || '{}');
      localStorage.setItem('content-prefs', JSON.stringify({ ...prev, ...patch }));
    } catch {}
    queryClient.invalidateQueries({ queryKey: ['posts'] });
  }, [queryClient]);

  const showFeedback = (label: string) => {
    setLastChanged(label);
    setTimeout(() => setLastChanged(null), 2000);
  };

  const updateAlgo = (algo: FeedAlgorithm) => {
    setFeedAlgo(algo); savePrefs({ feedAlgorithm: algo });
    const names = { smart: 'Intelligent', chronological: 'Chronologique', friends_first: 'Amis d\'abord' };
    showFeedback(names[algo]);
    toast.success(`Mode "${names[algo]}" activé`, { duration: 2000 });
  };
  const updateWeights = (w: FeedWeights, label: string) => {
    setFeedWeights(w); localStorage.setItem('feed-weights', JSON.stringify(w));
    savePrefs({}); showFeedback(label);
  };
  const updateDiversity = (v: number) => { setDiversityBoost(v); savePrefs({ diversityBoost: v }); showFeedback('Diversité'); };
  const updateViral = (v: boolean) => {
    setViralReduce(v); savePrefs({ viralContentReduce: v }); showFeedback(v ? 'Filtre activé' : 'Filtre désactivé');
    toast.success(v ? 'Filtre anti-viral activé' : 'Filtre anti-viral désactivé', { duration: 2000 });
  };

  const algoOptions = [
    { id: 'smart' as FeedAlgorithm, icon: <Brain className="w-4 h-4" />, label: 'Intelligent', desc: 'L\'IA sélectionne le contenu optimal' },
    { id: 'chronological' as FeedAlgorithm, icon: <Clock className="w-4 h-4" />, label: 'Chronologique', desc: 'Par ordre de publication' },
    { id: 'friends_first' as FeedAlgorithm, icon: <Users className="w-4 h-4" />, label: 'Amis d\'abord', desc: 'Priorité à vos amis' },
  ];

  return (
    <div className="px-4 py-3 space-y-4 overflow-y-auto flex-1">
      <AnimatePresence>
        {lastChanged && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
            className="flex items-center gap-2 p-2 rounded-xl bg-primary/10 border border-primary/20 text-primary">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span className="text-[11px]">{lastChanged} — mise à jour en cours...</span>
          </motion.div>
        )}
      </AnimatePresence>

      <FeedPreviewBar friends={feedWeights.friends} discovery={feedWeights.discovery}
        marketplace={feedWeights.marketplace} algo={feedAlgo} viralReduce={viralReduce} diversityBoost={diversityBoost} />

      <div className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <Cpu className="w-3 h-3" /> Mode de tri
        </h3>
        <div className="space-y-1.5">
          {algoOptions.map(opt => (
            <motion.button key={opt.id} onClick={() => updateAlgo(opt.id)}
              whileTap={{ scale: 0.98 }}
              className={cn(
                "w-full flex items-center gap-3 p-3 rounded-xl border transition-all duration-200 text-left",
                feedAlgo === opt.id
                  ? "bg-primary/10 border-primary/30 shadow-sm"
                  : "border-border hover:bg-accent hover:border-primary/15"
              )}>
              <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center transition-all",
                feedAlgo === opt.id ? "bg-primary text-primary-foreground shadow-md" : "bg-muted text-muted-foreground"
              )}>
                {opt.icon}
              </div>
              <div className="flex-1">
                <span className={cn("text-sm font-semibold", feedAlgo === opt.id ? "text-foreground" : "text-foreground/60")}>{opt.label}</span>
                <p className="text-[10px] text-muted-foreground mt-0.5">{opt.desc}</p>
              </div>
              {feedAlgo === opt.id && <CheckCircle2 className="w-5 h-5 text-primary" />}
            </motion.button>
          ))}
        </div>
      </div>

      {feedAlgo === 'smart' && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Sliders className="w-3 h-3" /> Pondération
          </h3>
          {[
            { key: 'friends' as keyof FeedWeights, label: 'Amis', color: 'bg-primary', hint: 'Contenu de vos amis' },
            { key: 'discovery' as keyof FeedWeights, label: 'Découverte', color: 'bg-violet-500', hint: 'Nouveau contenu à explorer' },
            { key: 'marketplace' as keyof FeedWeights, label: 'Marketplace', color: 'bg-amber-500', hint: 'Produits et annonces' },
          ].map(item => (
            <div key={item.key} className="space-y-1.5 p-3 rounded-xl bg-muted/50 border border-border">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-semibold text-foreground">{item.label}</span>
                  <p className="text-[9px] text-muted-foreground">{item.hint}</p>
                </div>
                <motion.span key={feedWeights[item.key]} initial={{ scale: 1.3 }} animate={{ scale: 1 }}
                  className={cn("text-sm font-bold tabular-nums px-2 py-0.5 rounded-md text-white", item.color)}>
                  {feedWeights[item.key]}%
                </motion.span>
              </div>
              <Slider
                value={[feedWeights[item.key]]}
                onValueChange={([v]) => updateWeights({ ...feedWeights, [item.key]: v }, item.label)}
                min={0} max={100} step={5}
              />
            </div>
          ))}
        </motion.div>
      )}

      <div className="space-y-2 p-3 rounded-xl bg-muted/50 border border-border">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-foreground">Diversité</span>
            <p className="text-[9px] text-muted-foreground">Niveau de diversification du contenu</p>
          </div>
          <motion.span key={diversityBoost} initial={{ scale: 1.3 }} animate={{ scale: 1 }}
            className="text-xs font-bold text-primary">{diversityBoost}%</motion.span>
        </div>
        <Slider value={[diversityBoost]} onValueChange={([v]) => updateDiversity(v)} min={0} max={100} step={10} />
        <div className="flex justify-between text-[9px] text-muted-foreground">
          <span>Stable</span>
          <span>Exploratoire</span>
        </div>
      </div>

      <motion.div whileTap={{ scale: 0.98 }}
        className={cn("flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer",
          viralReduce ? "bg-primary/10 border-primary/25" : "bg-muted/50 border-border"
        )} onClick={() => updateViral(!viralReduce)}>
        <div className="flex items-center gap-2">
          <Shield className={cn("w-4 h-4", viralReduce ? "text-primary" : "text-muted-foreground")} />
          <div>
            <p className="text-xs font-semibold text-foreground">Filtre anti-viral</p>
            <p className="text-[9px] text-muted-foreground">
              {viralReduce ? 'Actif — contenu authentique' : 'Inactif — contenu populaire visible'}
            </p>
          </div>
        </div>
        <Switch checked={viralReduce} onCheckedChange={updateViral} />
      </motion.div>

      <div className="p-3 rounded-xl bg-accent/50 border border-border">
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          💡 <strong className="text-foreground/70">Astuce :</strong> Dites « <em className="text-primary">Optimise mon fil</em> » dans le chat pour une optimisation automatique.
        </p>
      </div>
    </div>
  );
}

// ── Main Component ──
export function ZeusCompanion({ inline = false }: { inline?: boolean } = {}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const secureSendMessage = useSendMessage();
  const { zeusName, updateName } = useZeusSettings();
  const { data: zeusAgentId } = useZeusAgentId();
  const { unacknowledged } = useContentStrikes();
  const [open, setOpen] = useState(inline);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isNewConversation, setIsNewConversation] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState('');
  const [executingAction, setExecutingAction] = useState<number | null>(null);
  const [executedActions, setExecutedActions] = useState<Set<number>>(new Set());
  const [activeTab, setActiveTab] = useState<ActiveTab>('chat');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: conversations, refetch: refetchConversations } = useZeusConversations(zeusAgentId);
  const { data: loadedMessages } = useZeusMessages(conversationId);

  useEffect(() => {
    if (loadedMessages && loadedMessages.length > 0) {
      setMessages(loadedMessages);
      setActiveTab('chat');
    }
  }, [loadedMessages]);

  useEffect(() => {
    if (open && !conversationId && !isNewConversation && conversations && conversations.length > 0) {
      setConversationId(conversations[0].id);
    }
  }, [open, conversations, conversationId, isNewConversation]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => { if (open && inputRef.current && activeTab === 'chat') inputRef.current.focus(); }, [open, activeTab]);
  // Ref to hold a pending message that should be auto-sent once Zeus opens
  const pendingSendRef = useRef<string | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      setOpen(true);
      setActiveTab('chat');
      const detail = (e as CustomEvent)?.detail;
      if (detail?.action === 'translate' && detail?.text) {
        pendingSendRef.current = `Traduis ce texte : "${detail.text}"`;
        setInput(pendingSendRef.current);
      } else if (detail?.action === 'rewrite' && detail?.text) {
        pendingSendRef.current = `Réécris ce texte de manière plus élégante : "${detail.text}"`;
        setInput(pendingSendRef.current);
      } else if (detail?.action) {
        const prompts: Record<string, string> = {
          'search': '',
          'create-post': 'Aide-moi à créer une publication',
          'games': 'Aide-moi avec ce jeu',
          'live-help': 'Aide-moi pour mon live',
          'message-help': 'Aide-moi avec mes messages',
        };
        if (prompts[detail.action]) setInput(prompts[detail.action]);
      }
    };
    window.addEventListener('open-zeus', handler);
    return () => window.removeEventListener('open-zeus', handler);
  }, []);

  useEffect(() => {
    if (unacknowledged.length > 0 && !open) {
      const latest = unacknowledged[0] as any;
      toast.warning(latest.zeus_message || `${zeusName} a un message pour toi`, {
        duration: 8000,
        action: { label: 'Voir', onClick: () => setOpen(true) },
      });
    }
  }, [unacknowledged.length]);

  const startNewConversation = useCallback(() => {
    setConversationId(null);
    setMessages([]);
    setExecutedActions(new Set());
    setIsNewConversation(true);
    setActiveTab('chat');
  }, []);

  const selectConversation = useCallback((id: string) => {
    setConversationId(id);
    setExecutedActions(new Set());
    setIsNewConversation(false);
    setActiveTab('chat');
  }, []);

  const executeAction = useCallback(async (action: ActionBlock, msgIndex: number) => {
    if (!user) return;
    setExecutingAction(msgIndex);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Non authentifié');

      if (action.type === 'translate') {
        // Translate is client-only: copy to clipboard
        if (action.translated_text) {
          await navigator.clipboard.writeText(action.translated_text);
          toast.success('Traduction copiée ! 📋');
        }
        setExecutedActions(prev => new Set([...prev, msgIndex]));
        return;
      }

      if (action.type === 'update_feed_config') {
        setExecutedActions(prev => new Set([...prev, msgIndex]));
        toast.success('Configuration mise à jour ✓');
        return;
      }

      if (action.type === 'send_message') {
        if (!action.conversation_id || !action.message_text) {
          toast.error('Données de message incomplètes');
          return;
        }
        await secureSendMessage.mutateAsync({
          conversationId: action.conversation_id,
          body: action.message_text,
        });
        queryClient.invalidateQueries({ queryKey: ['messages', action.conversation_id] });
        queryClient.invalidateQueries({ queryKey: ['conversations'] });
        setExecutedActions(prev => new Set([...prev, msgIndex]));
        toast.success(`Message envoyé à ${action.recipient_name || 'votre ami'} ✉️`);
        return;
      }

      // Use agent-actions edge function for publish_post, schedule_post, create_story, generate_image
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const resp = await fetch(`${supabaseUrl}/functions/v1/agent-actions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ action }),
      });

      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Erreur');

      // Refresh feed after post/story
      if (action.type === 'publish_post' || action.type === 'schedule_post') {
        queryClient.invalidateQueries({ queryKey: ['posts'] });
      }
      if (action.type === 'create_story') {
        queryClient.invalidateQueries({ queryKey: ['stories'] });
      }

      toast.success(result.message || 'Action exécutée ! 🎉');
      setExecutedActions(prev => new Set([...prev, msgIndex]));
    } catch (err: any) {
      console.error('Zeus action error:', err);
      toast.error(err.message || 'Erreur lors de l\'action');
    } finally {
      setExecutingAction(null);
    }
  }, [user, queryClient, secureSendMessage]);

  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = overrideText || input.trim();
    if (!text || loading) return;

    // Guest mode: check 3-question limit
    if (!user) {
      const guestCount = parseInt(localStorage.getItem('forsure-zeus-guest-count') || '0', 10);
      if (guestCount >= 3) {
        toast.info('Inscrivez-vous pour continuer à utiliser Zeus', {
          description: '3 questions d\'essai utilisées. Créez un compte gratuit !',
          action: { label: "S'inscrire", onClick: () => navigate('/signup') },
        });
        return;
      }
    }

    if (!zeusAgentId) return;

    const userMsg: Msg = { role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      let headers: Record<string, string> = {
        'Content-Type': 'application/json',
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      };

      if (user) {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('Not authenticated');
        headers['Authorization'] = `Bearer ${session.access_token}`;
      } else {
        headers['Authorization'] = `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`;
      }

      const resp = await fetch(`${supabaseUrl}/functions/v1/agent-chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ agent_id: zeusAgentId, conversation_id: user ? conversationId : null, message: userMsg.content }),
      });

      if (user) {
        const convId = resp.headers.get('X-Conversation-Id');
        if (convId && convId !== conversationId) { setConversationId(convId); setIsNewConversation(false); refetchConversations(); }
      }

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Erreur' }));
        throw new Error(err.message || err.error || 'Erreur');
      }

      // Increment guest counter
      if (!user) {
        const prev = parseInt(localStorage.getItem('forsure-zeus-guest-count') || '0', 10);
        localStorage.setItem('forsure-zeus-guest-count', String(prev + 1));
      }

      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';
      setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

      if (reader) {
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nlIndex;
          while ((nlIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nlIndex).trim();
            buffer = buffer.slice(nlIndex + 1);
            if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
            try {
              const parsed = JSON.parse(line.slice(6));
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                assistantContent += content;
                setMessages(prev => {
                  const copy = [...prev];
                  copy[copy.length - 1] = { role: 'assistant', content: assistantContent };
                  return copy;
                });
              }
            } catch {}
          }
        }
      }

      if (!assistantContent) {
        try {
          const json = await resp.json();
          assistantContent = json.result || json.error || 'Pas de réponse';
          setMessages(prev => {
            const copy = [...prev];
            copy[copy.length - 1] = { role: 'assistant', content: assistantContent };
            return copy;
          });
        } catch {}
      }

      // After guest response, show remaining count
      if (!user) {
        const remaining = 3 - parseInt(localStorage.getItem('forsure-zeus-guest-count') || '0', 10);
        if (remaining > 0) {
          toast.info(`${remaining} question${remaining > 1 ? 's' : ''} d'essai restante${remaining > 1 ? 's' : ''}`, { duration: 3000 });
        } else {
          toast.info('Vous avez utilisé vos 3 questions d\'essai !', {
            description: 'Inscrivez-vous pour discuter sans limite avec Zeus.',
            action: { label: "S'inscrire", onClick: () => navigate('/signup') },
            duration: 6000,
          });
        }
      }
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `❌ ${err.message}` }]);
    } finally {
      setLoading(false);
    }
  }, [input, zeusAgentId, conversationId, loading, refetchConversations, user, navigate]);

  // Auto-send pending translate/rewrite messages
  useEffect(() => {
    if (open && pendingSendRef.current && zeusAgentId && !loading) {
      const text = pendingSendRef.current;
      pendingSendRef.current = null;
      sendMessage(text);
    }
  }, [open, zeusAgentId, loading, sendMessage]);

  const handleRename = () => {
    if (newName.trim()) { updateName.mutate(newName.trim()); }
    setEditingName(false);
  };

  const guestCount = parseInt(localStorage.getItem('forsure-zeus-guest-count') || '0', 10);
  const guestLimitReached = !user && guestCount >= 3;

  const tabs = [
    { id: 'chat' as ActiveTab, icon: <MessageSquare className="w-3.5 h-3.5" />, label: 'Chat' },
    ...(user ? [
      { id: 'algo' as ActiveTab, icon: <Sliders className="w-3.5 h-3.5" />, label: 'Algo' },
      { id: 'history' as ActiveTab, icon: <History className="w-3.5 h-3.5" />, label: 'Historique' },
    ] : []),
  ];

  return (
    <>
      {/* FAB Button (mobile only when not inline) */}
      <AnimatePresence>
        {!open && !inline && (
          <motion.button
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 20 }}
            onClick={() => setOpen(true)}
            className={cn(
              "fixed bottom-[80px] right-5 z-[55] w-14 h-14 rounded-2xl flex items-center justify-center",
              "bg-primary text-primary-foreground shadow-lg hover:shadow-xl active:scale-95 transition-all group md:hidden",
              inline && "hidden"
            )}
          >
            <Zap className="w-6 h-6" />
            {unacknowledged.length > 0 && (
              <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-[10px] font-bold flex items-center justify-center text-destructive-foreground ring-2 ring-background shadow-md">
                {unacknowledged.length}
              </motion.span>
            )}
          </motion.button>
        )}
      </AnimatePresence>

      {/* Main Panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className={cn(
              "flex flex-col overflow-hidden bg-card border border-border shadow-xl",
              inline
                ? "w-full h-[420px] max-h-[420px] rounded-2xl"
                : "fixed bottom-[80px] right-5 z-[55] w-[390px] max-w-[calc(100vw-2rem)] h-[560px] max-h-[calc(100vh-120px)] md:right-8 rounded-2xl"
            )}
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-border bg-card">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-primary text-primary-foreground shadow-sm">
                    <Zap className="w-4 h-4" />
                  </div>
                  {editingName ? (
                    <div className="flex items-center gap-1">
                      <Input value={newName} onChange={e => setNewName(e.target.value)} className="h-7 w-28 text-sm rounded-lg" maxLength={20} autoFocus onKeyDown={e => e.key === 'Enter' && handleRename()} />
                      <button onClick={handleRename} className="text-primary"><Check className="w-4 h-4" /></button>
                      <button onClick={() => setEditingName(false)} className="text-muted-foreground"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-sm text-foreground">{zeusName}</span>
                      <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-sm" />
                      <button onClick={() => { setNewName(zeusName); setEditingName(true); }} className="text-muted-foreground/40 hover:text-muted-foreground transition-colors">
                        <Pencil className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={startNewConversation} className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-all" title="Nouvelle conversation">
                    <Plus className="w-4 h-4" />
                  </button>
                  {!inline && (
                    <button onClick={() => setOpen(false)} className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-all">
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Tab Bar */}
            <div className="flex px-3 pt-2 pb-1 gap-1 bg-card">
              {tabs.map(tab => (
                <button key={tab.id} onClick={() => { setActiveTab(tab.id); if (tab.id === 'history') refetchConversations(); }}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-[11px] font-medium tracking-wide transition-all duration-200",
                    activeTab === tab.id
                      ? "text-primary bg-primary/10 border border-primary/20"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent border border-transparent"
                  )}>
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>

            {/* Strike warnings */}
            {activeTab === 'chat' && unacknowledged.length > 0 && (
              <div className="mx-3 mt-1 px-3 py-2 rounded-xl bg-destructive/10 border border-destructive/20">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-destructive mt-0.5 shrink-0" />
                  <p className="text-[11px] text-destructive leading-relaxed">
                    {(unacknowledged[0] as any).zeus_message || 'Alerte : contenu signalé détecté.'}
                  </p>
                </div>
              </div>
            )}

            {/* Chat Content */}
            {activeTab === 'chat' && (
              <>
                <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">
                  {messages.length === 0 && (
                    <div className="text-center py-4">
                      <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', delay: 0.1 }}
                        className="w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center bg-primary/10 border border-primary/20">
                        <Zap className="w-7 h-7 text-primary" />
                      </motion.div>
                      <p className="text-sm font-semibold text-foreground">
                        {zeusName} <span className="text-muted-foreground font-normal">est en ligne</span>
                      </p>
                      <p className="text-xs text-muted-foreground mt-1 mb-4">Votre assistant IA personnel</p>
                      
                      {/* Capabilities */}
                      <div className="text-left mx-1 space-y-1 mb-4">
                        {[
                          { icon: <Pencil className="w-3 h-3" />, text: 'Création et publication automatique' },
                          { icon: <Search className="w-3 h-3" />, text: 'Recherche sur internet en temps réel' },
                          { icon: <ShoppingBag className="w-3 h-3" />, text: 'Recherche marketplace' },
                          { icon: <Globe className="w-3 h-3" />, text: 'Traduction multilingue' },
                          { icon: <MessageSquare className="w-3 h-3" />, text: 'Assistance conversationnelle' },
                          { icon: <Shield className="w-3 h-3" />, text: 'Sécurité de votre compte' },
                        ].map((cap, idx) => (
                          <motion.div key={idx} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: 0.1 + idx * 0.05 }}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-accent/30">
                            <span className="text-primary/60">{cap.icon}</span>
                            <span className="text-[11px] text-muted-foreground">{cap.text}</span>
                          </motion.div>
                        ))}
                      </div>

                      {/* Quick actions */}
                      <div className="flex flex-wrap gap-1.5 justify-center">
                        {[
                          { label: '✍️ Post', value: 'Publie un post motivant' },
                          { label: '🌍 Traduis', value: 'Traduis en anglais' },
                          { label: '🛍️ Market', value: 'Cherche un produit' },
                          { label: '🔍 Recherche', value: 'Cherche sur internet' },
                        ].map(s => (
                          <button key={s.value} onClick={() => setInput(s.value)}
                            className="text-[11px] px-3 py-1.5 rounded-full text-foreground/60 hover:text-foreground transition-all border border-border hover:border-primary/30 hover:bg-accent">
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {messages.map((msg, i) => {
                    let displayText = msg.content;
                    let action: ActionBlock | null = null;
                    let products: ProductItem[] | null = null;

                    if (msg.role === 'assistant') {
                      const actionResult = parseActionFromContent(displayText);
                      displayText = actionResult.text;
                      action = actionResult.action;
                      if (action) console.log('[Zeus] Action parsed:', action);
                      const productResult = parseProductsFromContent(displayText);
                      displayText = productResult.text;
                      products = productResult.products;
                      displayText = stripCodeBlocks(displayText);
                    }

                    return (
                      <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                        className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                        {msg.role === 'assistant' && (
                          <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 mt-1 mr-1.5 bg-primary/10 border border-primary/20">
                            <Zap className="w-3 h-3 text-primary" />
                          </div>
                        )}
                        <div className={cn(
                          'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                          msg.role === 'user'
                            ? 'rounded-br-lg bg-primary text-primary-foreground'
                            : 'rounded-bl-lg bg-muted border border-border text-foreground'
                        )}>
                          {msg.role === 'assistant' ? (
                            <div className="prose prose-sm dark:prose-invert max-w-none [&>p]:m-0 [&>ul]:mt-1 [&_a]:text-primary [&_code]:text-primary [&_code]:bg-primary/10 [&_code]:rounded [&_code]:px-1">
                              <SafeMarkdown>{displayText}</SafeMarkdown>
                            </div>
                          ) : (
                            <p className="whitespace-pre-wrap">{displayText}</p>
                          )}
                          {action && (
                            <ActionCard action={action} onExecute={() => executeAction(action!, i)}
                              executing={executingAction === i} executed={executedActions.has(i)} />
                          )}
                          {products && <ProductCards products={products} onNavigate={(id) => navigate(`/marketplace/product/${id}`)} />}
                        </div>
                      </motion.div>
                    );
                  })}
                  {loading && (
                    <div className="flex justify-start">
                      <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 mt-1 mr-1.5 bg-primary/10 border border-primary/20">
                        <Zap className="w-3 h-3 text-primary" />
                      </div>
                      <div className="rounded-2xl rounded-bl-lg px-4 py-3 border border-border bg-muted">
                        <div className="flex gap-1.5">
                          <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.2, repeat: Infinity, delay: 0 }} className="w-2 h-2 rounded-full bg-primary" />
                          <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.2, repeat: Infinity, delay: 0.2 }} className="w-2 h-2 rounded-full bg-primary" />
                          <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.2, repeat: Infinity, delay: 0.4 }} className="w-2 h-2 rounded-full bg-primary" />
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <div className="px-3 py-3 border-t border-border bg-card">
                  {guestLimitReached ? (
                    <div className="flex flex-col items-center gap-2 py-1">
                      <p className="text-xs text-muted-foreground text-center">Vous avez utilisé vos 3 questions d'essai</p>
                      <Button size="sm" className="rounded-xl w-full" onClick={() => navigate('/signup')}>
                        S'inscrire pour continuer
                      </Button>
                    </div>
                  ) : (
                    <form onSubmit={e => { e.preventDefault(); sendMessage(); }} className="flex gap-2">
                      <Input ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
                        placeholder={!user ? `Essayez Zeus (${Math.max(0, 3 - guestCount)} restantes)...` : `Message ${zeusName}...`}
                        className="flex-1 rounded-xl h-10 text-sm"
                        disabled={loading || !zeusAgentId} />
                      <Button type="submit" size="icon" disabled={!input.trim() || loading || !zeusAgentId}
                        className="h-10 w-10 rounded-xl">
                        <Send className="w-4 h-4" />
                      </Button>
                    </form>
                  )}
                </div>
              </>
            )}

            {activeTab === 'algo' && <div className="flex-1 overflow-hidden flex flex-col"><AlgorithmPanel /></div>}

            {activeTab === 'history' && (
              <div className="flex-1 overflow-y-auto">
                <div className="px-3 pt-3 pb-1">
                  <button onClick={startNewConversation}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-border text-primary hover:bg-accent transition-all text-[11px] font-medium">
                    <Plus className="w-4 h-4" />
                    Nouvelle conversation
                  </button>
                </div>
                {(!conversations || conversations.length === 0) ? (
                  <div className="text-center py-12 text-muted-foreground text-sm">
                    <History className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
                    <p>Aucune conversation</p>
                  </div>
                ) : (
                  <div className="p-2 space-y-1">
                    {conversations.map((conv: any) => (
                      <button key={conv.id} onClick={() => selectConversation(conv.id)}
                        className={cn(
                          "w-full text-left px-3.5 py-3 rounded-xl transition-all duration-200 group border",
                          conversationId === conv.id
                            ? "border-primary/25 bg-primary/5 shadow-sm"
                            : "border-transparent hover:bg-accent hover:border-border"
                        )}>
                        <div className="flex items-center justify-between">
                          <p className="text-sm text-foreground truncate flex-1">{conv.title || 'Conversation'}</p>
                          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors" />
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {new Date(conv.updated_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
