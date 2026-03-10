import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Send, Loader2, Pencil, Check, Zap, AlertTriangle, CheckCircle2,
  Plus, History, ArrowLeft, ShoppingBag, Sliders, Brain, Users, Clock,
  Sparkles, ChevronRight, BarChart3
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useZeusSettings, useZeusAgentId, useContentStrikes } from '@/hooks/useZeusCompanion';
import { useZeusConversations, useZeusMessages } from '@/hooks/useZeusConversations';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { loadFeedWeights, type FeedWeights } from '@/lib/feedAlgorithm';

type Msg = { role: string; content: string };
type ActiveTab = 'chat' | 'algo' | 'history';
type FeedAlgorithm = 'smart' | 'chronological' | 'friends_first';

interface ActionBlock {
  type: 'publish_post' | 'schedule_post' | 'create_story' | 'generate_image' | 'translate' | 'update_feed_config';
  body?: string;
  caption?: string;
  publish_at?: string;
  image_prompt?: string | null;
  prompt?: string;
  target_language?: string;
  translated_text?: string;
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
    if (!match) continue;
    try {
      const products = JSON.parse((match[1] || match[0]).trim()) as ProductItem[];
      if (Array.isArray(products) && products.length > 0) return { text: content.replace(match[0], '').trim(), products };
    } catch { continue; }
  }
  return { text: content, products: null };
}

function parseActionFromContent(content: string): { text: string; action: ActionBlock | null } {
  const patterns = [
    /```forsure-action\s*\n([\s\S]*?)\n```/,
    /```forsure-action\s*([\s\S]*?)```/,
    /```json\s*\n([\s\S]*?)\n```/,
    /\{[^{}]*"type"\s*:\s*"(publish_post|schedule_post|create_story|generate_image|translate|update_feed_config)"[^{}]*\}/,
  ];
  for (const regex of patterns) {
    const match = content.match(regex);
    if (!match) continue;
    try {
      const action = JSON.parse((match[1] || match[0]).trim()) as ActionBlock;
      if (action.type && ['publish_post', 'schedule_post', 'create_story', 'generate_image', 'translate', 'update_feed_config'].includes(action.type)) {
        return { text: content.replace(match[0], '').trim(), action };
      }
    } catch { continue; }
  }
  return { text: content, action: null };
}

// Strip any remaining code blocks or raw JSON that Zeus might accidentally show
function stripCodeBlocks(content: string): string {
  return content
    .replace(/```[\w-]*\s*\n[\s\S]*?\n```/g, '')
    .replace(/```[\w-]*[\s\S]*?```/g, '')
    .replace(/\{[^{}]*"type"\s*:\s*"[^"]*"[^{}]*\}/g, '')
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
            className="rounded-xl border border-border/20 bg-background/60 backdrop-blur-sm overflow-hidden hover:border-primary/40 transition-all text-left group hover:shadow-md">
            {p.thumbnail_url ? (
              <div className="aspect-square w-full overflow-hidden bg-muted/50">
                <img src={p.thumbnail_url} alt={p.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
              </div>
            ) : (
              <div className="aspect-square w-full bg-muted/30 flex items-center justify-center">
                <ShoppingBag className="w-6 h-6 text-muted-foreground/30" />
              </div>
            )}
            <div className="p-1.5">
              <p className="text-[10px] font-medium text-foreground truncate">{p.title}</p>
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
  const labels: Record<string, { icon: string; label: string }> = {
    publish_post: { icon: '📝', label: 'Publier ce post' },
    schedule_post: { icon: '📅', label: 'Programmer ce post' },
    create_story: { icon: '📸', label: 'Créer cette story' },
    generate_image: { icon: '🎨', label: 'Générer cette image' },
    translate: { icon: '🌐', label: 'Traduction' },
    update_feed_config: { icon: '⚙️', label: 'Ajuster ton algorithme' },
  };
  const info = labels[action.type] || { icon: '⚡', label: 'Action' };
  const preview = action.body || action.caption || action.translated_text || action.prompt || '';

  return (
    <div className="mt-2.5 p-3 rounded-xl bg-gradient-to-br from-amber-500/5 to-orange-500/5 border border-amber-500/15 space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="text-sm">{info.icon}</span>
        <span className="text-xs font-semibold text-amber-600 dark:text-amber-400">{info.label}</span>
        {action.publish_at && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {new Date(action.publish_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}
          </span>
        )}
      </div>
      {preview && <p className="text-xs text-foreground/80 bg-background/60 backdrop-blur-sm rounded-lg p-2.5 whitespace-pre-wrap leading-relaxed">{preview}</p>}
      {executed ? (
        <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
          <CheckCircle2 className="w-3.5 h-3.5" /><span>Action effectuée !</span>
        </div>
      ) : (
        <Button size="sm" onClick={onExecute} disabled={executing}
          className="w-full h-8 text-xs rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white shadow-sm shadow-amber-500/20">
          {executing ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
          {executing ? 'En cours...' : '✨ Confirmer'}
        </Button>
      )}
    </div>
  );
}

// ── Feed Preview Simulation ──
function FeedPreviewBar({ friends, discovery, marketplace, algo, viralReduce, diversityBoost }: {
  friends: number; discovery: number; marketplace: number; algo: FeedAlgorithm; viralReduce: boolean; diversityBoost: number;
}) {
  // Simulate a feed composition based on current weights
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
    friend: 'bg-blue-400', discovery: 'bg-violet-400', marketplace: 'bg-amber-400', chrono: 'bg-cyan-400',
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Aperçu de ton fil</span>
        <span className="text-[9px] text-muted-foreground">En direct</span>
      </div>
      <div className="flex gap-0.5 h-8 rounded-lg overflow-hidden border border-border/20">
        <motion.div animate={{ width: `${fPct}%` }} transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className="bg-blue-400/80 flex items-center justify-center min-w-0"
          title={`Amis: ${fPct}%`}>
          {fPct > 15 && <span className="text-[8px] text-white font-bold">👥 {fPct}%</span>}
        </motion.div>
        <motion.div animate={{ width: `${dPct}%` }} transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className="bg-violet-400/80 flex items-center justify-center min-w-0"
          title={`Découverte: ${dPct}%`}>
          {dPct > 15 && <span className="text-[8px] text-white font-bold">🔍 {dPct}%</span>}
        </motion.div>
        <motion.div animate={{ width: `${mPct}%` }} transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className="bg-amber-400/80 flex items-center justify-center min-w-0"
          title={`Marketplace: ${mPct}%`}>
          {mPct > 15 && <span className="text-[8px] text-white font-bold">🛍️ {mPct}%</span>}
        </motion.div>
      </div>
      {/* Mini feed dots */}
      <div className="flex gap-1 justify-center">
        {posts.map((type, i) => (
          <motion.div key={i} layout
            initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: i * 0.03 }}
            className={cn("w-3 h-4 rounded-sm", colors[type])}
            title={type === 'friend' ? 'Post d\'ami' : type === 'discovery' ? 'Découverte' : type === 'marketplace' ? 'Marketplace' : 'Chronologique'}
          />
        ))}
      </div>
      <div className="flex gap-3 justify-center">
        <span className="flex items-center gap-1 text-[8px] text-muted-foreground"><span className="w-2 h-2 rounded-sm bg-blue-400 inline-block" /> Amis</span>
        <span className="flex items-center gap-1 text-[8px] text-muted-foreground"><span className="w-2 h-2 rounded-sm bg-violet-400 inline-block" /> Découverte</span>
        <span className="flex items-center gap-1 text-[8px] text-muted-foreground"><span className="w-2 h-2 rounded-sm bg-amber-400 inline-block" /> Marketplace</span>
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
    // Refresh feed in real-time
    queryClient.invalidateQueries({ queryKey: ['posts'] });
  }, [queryClient]);

  const showFeedback = (label: string) => {
    setLastChanged(label);
    setTimeout(() => setLastChanged(null), 2000);
  };

  const updateAlgo = (algo: FeedAlgorithm) => {
    setFeedAlgo(algo); savePrefs({ feedAlgorithm: algo });
    const names = { smart: 'Mode Smart', chronological: 'Mode Chrono', friends_first: 'Mode Amis' };
    showFeedback(names[algo]);
    toast.success(`${names[algo]} activé ✨`, { duration: 2000 });
  };
  const updateWeights = (w: FeedWeights, label: string) => {
    setFeedWeights(w); localStorage.setItem('feed-weights', JSON.stringify(w));
    savePrefs({}); showFeedback(label);
  };
  const updateDiversity = (v: number) => { setDiversityBoost(v); savePrefs({ diversityBoost: v }); showFeedback('Diversité'); };
  const updateViral = (v: boolean) => {
    setViralReduce(v); savePrefs({ viralContentReduce: v }); showFeedback(v ? 'Viral réduit' : 'Viral normal');
    toast.success(v ? 'Contenu viral réduit 🛡️' : 'Contenu viral normal 📈', { duration: 2000 });
  };

  const algoOptions = [
    { id: 'smart' as FeedAlgorithm, icon: <Brain className="w-5 h-5" />, label: 'Smart', desc: 'L\'IA choisit les meilleurs posts pour toi', emoji: '🧠' },
    { id: 'chronological' as FeedAlgorithm, icon: <Clock className="w-5 h-5" />, label: 'Chrono', desc: 'Les plus récents apparaissent en premier', emoji: '⏰' },
    { id: 'friends_first' as FeedAlgorithm, icon: <Users className="w-5 h-5" />, label: 'Amis d\'abord', desc: 'Tes amis sont toujours en haut du fil', emoji: '💙' },
  ];

  return (
    <div className="px-4 py-3 space-y-4 overflow-y-auto flex-1">
      {/* Change feedback toast */}
      <AnimatePresence>
        {lastChanged && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
            className="flex items-center gap-2 p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span className="text-[11px] font-medium">{lastChanged} — ton fil se met à jour !</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Live Preview */}
      <FeedPreviewBar friends={feedWeights.friends} discovery={feedWeights.discovery}
        marketplace={feedWeights.marketplace} algo={feedAlgo} viralReduce={viralReduce} diversityBoost={diversityBoost} />

      {/* Algorithm Mode - bigger touch targets */}
      <div className="space-y-2">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/70 flex items-center gap-1.5">
          <Sparkles className="w-3 h-3" /> Comment trier ton fil ?
        </h3>
        <div className="space-y-1.5">
          {algoOptions.map(opt => (
            <motion.button key={opt.id} onClick={() => updateAlgo(opt.id)}
              whileTap={{ scale: 0.98 }}
              className={cn(
                "w-full flex items-center gap-3 p-3 rounded-xl border transition-all duration-200 text-left",
                feedAlgo === opt.id
                  ? "bg-gradient-to-r from-primary/10 to-primary/5 border-primary/30 shadow-sm ring-1 ring-primary/10"
                  : "border-border/20 hover:bg-secondary/30"
              )}>
              <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center text-lg transition-all",
                feedAlgo === opt.id ? "bg-primary text-primary-foreground shadow-md" : "bg-muted text-muted-foreground"
              )}>
                {opt.emoji}
              </div>
              <div className="flex-1">
                <span className={cn("text-sm font-semibold", feedAlgo === opt.id && "text-primary")}>{opt.label}</span>
                <p className="text-[10px] text-muted-foreground mt-0.5">{opt.desc}</p>
              </div>
              {feedAlgo === opt.id && (
                <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }}>
                  <CheckCircle2 className="w-5 h-5 text-primary" />
                </motion.div>
              )}
            </motion.button>
          ))}
        </div>
      </div>

      {/* Feed Weights - with descriptive labels */}
      {feedAlgo === 'smart' && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-3">
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/70 flex items-center gap-1.5">
            <Sliders className="w-3 h-3" /> Ajuste ton fil en glissant
          </h3>
          
          {[
            { key: 'friends' as keyof FeedWeights, label: 'Posts de tes amis', icon: '👥', color: 'bg-blue-500', hint: 'Plus c\'est haut, plus tu vois tes proches' },
            { key: 'discovery' as keyof FeedWeights, label: 'Nouveaux contenus', icon: '🔍', color: 'bg-violet-500', hint: 'Découvre des créateurs que tu ne suis pas encore' },
            { key: 'marketplace' as keyof FeedWeights, label: 'Produits à vendre', icon: '🛍️', color: 'bg-amber-500', hint: 'Articles de la marketplace dans ton fil' },
          ].map(item => (
            <div key={item.key} className="space-y-1.5 p-3 rounded-xl bg-secondary/15 border border-border/10">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-base">{item.icon}</span>
                  <div>
                    <span className="text-xs font-semibold">{item.label}</span>
                    <p className="text-[9px] text-muted-foreground">{item.hint}</p>
                  </div>
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
                className="[&_[role=slider]]:h-5 [&_[role=slider]]:w-5 [&_[role=slider]]:shadow-md [&_[role=slider]]:border-2"
              />
            </div>
          ))}
        </motion.div>
      )}

      {/* Diversity - visual scale */}
      <div className="space-y-2 p-3 rounded-xl bg-secondary/15 border border-border/10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-muted-foreground" />
            <div>
              <span className="text-xs font-semibold">Variété du contenu</span>
              <p className="text-[9px] text-muted-foreground">Voir toujours les mêmes ou découvrir plus ?</p>
            </div>
          </div>
          <motion.span key={diversityBoost} initial={{ scale: 1.3 }} animate={{ scale: 1 }}
            className="text-xs font-bold text-primary">{diversityBoost}%</motion.span>
        </div>
        <Slider value={[diversityBoost]} onValueChange={([v]) => updateDiversity(v)} min={0} max={100} step={10}
          className="[&_[role=slider]]:h-5 [&_[role=slider]]:w-5" />
        <div className="flex justify-between text-[9px] text-muted-foreground">
          <span>🏠 Habituel</span>
          <span>🌍 Varié</span>
        </div>
      </div>

      {/* Viral toggle */}
      <motion.div whileTap={{ scale: 0.98 }}
        className={cn("flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer",
          viralReduce ? "bg-primary/5 border-primary/20" : "bg-secondary/15 border-border/10"
        )} onClick={() => updateViral(!viralReduce)}>
        <div className="flex items-center gap-2">
          <span className="text-base">{viralReduce ? '🛡️' : '📈'}</span>
          <div>
            <p className="text-xs font-semibold">Réduire le contenu viral</p>
            <p className="text-[9px] text-muted-foreground">
              {viralReduce ? 'Activé — ton fil est plus authentique' : 'Désactivé — le contenu populaire apparaît normalement'}
            </p>
          </div>
        </div>
        <Switch checked={viralReduce} onCheckedChange={updateViral} />
      </motion.div>

      {/* Tip */}
      <div className="p-3 rounded-xl bg-gradient-to-br from-amber-500/5 to-orange-500/5 border border-amber-500/10">
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          💡 <strong>Astuce :</strong> Dis « <em>Optimise mon fil</em> » à Zeus dans le chat et il ajustera tout pour toi automatiquement !
        </p>
      </div>
    </div>
  );
}

// ── Main Component ──
export function ZeusCompanion() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { zeusName, updateName } = useZeusSettings();
  const { data: zeusAgentId } = useZeusAgentId();
  const { unacknowledged } = useContentStrikes();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
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
    if (open && !conversationId && conversations && conversations.length > 0) {
      setConversationId(conversations[0].id);
    }
  }, [open, conversations, conversationId]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => { if (open && inputRef.current && activeTab === 'chat') inputRef.current.focus(); }, [open, activeTab]);
  useEffect(() => {
    const handler = () => setOpen(true);
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
    setActiveTab('chat');
  }, []);

  const selectConversation = useCallback((id: string) => {
    setConversationId(id);
    setExecutedActions(new Set());
    setActiveTab('chat');
  }, []);

  const executeAction = useCallback(async (action: ActionBlock, msgIndex: number) => {
    if (!user) return;
    setExecutingAction(msgIndex);
    try {
      if (action.type === 'publish_post' || action.type === 'schedule_post') {
        const { data: newPost, error } = await supabase.from('posts').insert({
          user_id: user.id, body: action.body || '', image_url: null,
        }).select().single();
        if (error) throw error;
        queryClient.setQueriesData<any>({ queryKey: ['posts', 'friends-feed'] }, (old: any) => {
          if (!old?.pages) return old;
          const profile = queryClient.getQueryData<any>(['profile', user.id]);
          const optimisticPost = {
            id: newPost.id, user_id: newPost.user_id, body: newPost.body,
            image_url: newPost.image_url, created_at: newPost.created_at, expires_at: newPost.expires_at || null,
            profile: { name: profile?.name || user.user_metadata?.name || 'Moi', avatar_url: profile?.avatar_url || null, mood_emoji: profile?.mood_emoji || null },
            likes_count: 0, comments_count: 0, is_liked: false, user_reaction: null,
          };
          return { ...old, pages: [[optimisticPost, ...old.pages[0]], ...old.pages.slice(1)] };
        });
        queryClient.invalidateQueries({ queryKey: ['posts'] });
        toast.success(action.type === 'schedule_post' ? 'Post publié ! 📅' : 'Post publié ! 🎉');
      } else if (action.type === 'translate') {
        await navigator.clipboard.writeText(action.translated_text || action.body || '');
        toast.success('Traduction copiée ! 📋');
      } else if (action.type === 'create_story') {
        toast.success('Story créée ! 📸');
      } else {
        toast.info('Action notée ✅');
      }
      setExecutedActions(prev => new Set(prev).add(msgIndex));
    } catch (e: any) {
      toast.error(e.message || "Erreur lors de l'action");
    } finally {
      setExecutingAction(null);
    }
  }, [user, queryClient]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || !zeusAgentId || loading) return;
    const userMsg: Msg = { role: 'user', content: input.trim() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const resp = await fetch(`https://${projectId}.supabase.co/functions/v1/agent-chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ agent_id: zeusAgentId, conversation_id: conversationId, message: userMsg.content }),
      });

      const convId = resp.headers.get('X-Conversation-Id');
      if (convId && convId !== conversationId) { setConversationId(convId); refetchConversations(); }

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Erreur' }));
        throw new Error(err.message || err.error || 'Erreur');
      }

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              assistantContent += content;
              setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant') return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: assistantContent } : m);
                return [...prev, { role: 'assistant', content: assistantContent }];
              });
            }
          } catch {}
        }
      }
    } catch (e: any) {
      toast.error(e.message || 'Erreur de communication');
    } finally {
      setLoading(false);
    }
  }, [input, zeusAgentId, conversationId, loading, refetchConversations]);

  const handleRename = () => {
    if (newName.trim() && newName.trim().length <= 20) { updateName.mutate(newName.trim()); setEditingName(false); }
  };

  if (!user) return null;

  const tabs: { id: ActiveTab; icon: React.ReactNode; label: string }[] = [
    { id: 'chat', icon: <Zap className="w-4 h-4" />, label: 'Chat' },
    { id: 'algo', icon: <Sliders className="w-4 h-4" />, label: 'Algo' },
    { id: 'history', icon: <History className="w-4 h-4" />, label: 'Historique' },
  ];

  return (
    <>
      {/* FAB Button */}
      <AnimatePresence>
        {!open && (
          <motion.button
            initial={{ scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            exit={{ scale: 0, rotate: 180 }}
            transition={{ type: 'spring', stiffness: 260, damping: 20 }}
            onClick={() => setOpen(true)}
            className="fixed bottom-20 right-4 z-50 w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-400 via-orange-500 to-red-500 shadow-lg shadow-orange-500/25 flex items-center justify-center text-white hover:shadow-xl hover:shadow-orange-500/30 transition-shadow active:scale-95"
          >
            <Zap className="w-6 h-6" />
            {unacknowledged.length > 0 && (
              <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-[10px] font-bold flex items-center justify-center text-white ring-2 ring-background">
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
            initial={{ opacity: 0, y: 40, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 40, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed bottom-4 right-4 z-50 w-[380px] max-w-[calc(100vw-2rem)] h-[540px] max-h-[75vh] rounded-3xl border border-border/20 bg-card/95 backdrop-blur-xl shadow-2xl shadow-black/10 flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="relative px-4 py-3 border-b border-border/10">
              {/* Gradient accent line */}
              <div className="absolute top-0 left-4 right-4 h-[2px] bg-gradient-to-r from-amber-400 via-orange-500 to-red-500 rounded-full" />
              
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 via-orange-500 to-red-500 flex items-center justify-center text-white text-sm shadow-sm shadow-orange-500/20">
                    ⚡
                  </div>
                  {editingName ? (
                    <div className="flex items-center gap-1">
                      <Input value={newName} onChange={e => setNewName(e.target.value)} className="h-7 w-28 text-sm rounded-lg" maxLength={20} autoFocus onKeyDown={e => e.key === 'Enter' && handleRename()} />
                      <button onClick={handleRename} className="text-primary"><Check className="w-4 h-4" /></button>
                      <button onClick={() => setEditingName(false)} className="text-muted-foreground"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-sm bg-gradient-to-r from-amber-500 to-orange-600 bg-clip-text text-transparent">{zeusName}</span>
                      <button onClick={() => { setNewName(zeusName); setEditingName(true); }} className="text-muted-foreground/50 hover:text-muted-foreground transition-colors">
                        <Pencil className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={startNewConversation} className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-all" title="Nouvelle conversation">
                    <Plus className="w-4 h-4" />
                  </button>
                  <button onClick={() => setOpen(false)} className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-all">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Tab Bar */}
            <div className="flex px-3 pt-2 pb-1 gap-1">
              {tabs.map(tab => (
                <button key={tab.id} onClick={() => { setActiveTab(tab.id); if (tab.id === 'history') refetchConversations(); }}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-medium transition-all duration-200",
                    activeTab === tab.id
                      ? "bg-gradient-to-r from-amber-500/10 to-orange-500/10 text-amber-600 dark:text-amber-400 shadow-sm border border-amber-500/15"
                      : "text-muted-foreground hover:bg-secondary/30"
                  )}>
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>

            {/* Strike warnings */}
            {activeTab === 'chat' && unacknowledged.length > 0 && (
              <div className="mx-3 mt-1 px-3 py-2 rounded-xl bg-amber-500/8 border border-amber-500/15">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
                  <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-relaxed">
                    {(unacknowledged[0] as any).zeus_message || 'Un de tes contenus a été signalé. Fais attention ! 🙏'}
                  </p>
                </div>
              </div>
            )}

            {/* Content Area */}
            {activeTab === 'chat' && (
              <>
                <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">
                  {messages.length === 0 && (
                    <div className="text-center py-8">
                      <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', delay: 0.1 }}
                        className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-amber-400/20 to-orange-500/20 flex items-center justify-center">
                        <span className="text-3xl">⚡</span>
                      </motion.div>
                      <p className="text-sm font-semibold text-foreground">
                        Salut ! Je suis <span className="bg-gradient-to-r from-amber-500 to-orange-600 bg-clip-text text-transparent">{zeusName}</span>
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">Ton assistant IA personnel</p>
                      <div className="flex flex-wrap gap-1.5 justify-center mt-4">
                        {[
                          { label: '📝 Publie un post', value: 'Publie un post motivant' },
                          { label: '🌐 Traduis', value: 'Traduis en anglais' },
                          { label: '🛍️ Marketplace', value: 'Cherche un produit' },
                          { label: '⚙️ Mon algo', value: 'Optimise mon fil' },
                        ].map(s => (
                          <button key={s.value} onClick={() => setInput(s.value)}
                            className="text-[10px] px-3 py-1.5 rounded-full bg-secondary/40 text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-all duration-200 border border-border/10">
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
                      const productResult = parseProductsFromContent(displayText);
                      displayText = productResult.text;
                      products = productResult.products;
                    }

                    return (
                      <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                        className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                        {msg.role === 'assistant' && (
                          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-amber-400/20 to-orange-500/20 flex items-center justify-center text-xs shrink-0 mt-1 mr-1.5">
                            ⚡
                          </div>
                        )}
                        <div className={cn(
                          'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                          msg.role === 'user'
                            ? 'bg-gradient-to-br from-primary to-primary/90 text-primary-foreground rounded-br-lg shadow-sm'
                            : 'bg-secondary/40 text-foreground rounded-bl-lg border border-border/10'
                        )}>
                          {msg.role === 'assistant' ? (
                            <div className="prose prose-sm dark:prose-invert max-w-none [&>p]:m-0 [&>ul]:mt-1">
                              <ReactMarkdown>{displayText}</ReactMarkdown>
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
                      <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-amber-400/20 to-orange-500/20 flex items-center justify-center text-xs shrink-0 mt-1 mr-1.5">⚡</div>
                      <div className="bg-secondary/40 rounded-2xl rounded-bl-lg px-4 py-3 border border-border/10">
                        <div className="flex gap-1">
                          <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: 0 }} className="w-2 h-2 rounded-full bg-amber-500" />
                          <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: 0.2 }} className="w-2 h-2 rounded-full bg-orange-500" />
                          <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: 0.4 }} className="w-2 h-2 rounded-full bg-red-500" />
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <div className="px-3 py-3 border-t border-border/10">
                  <form onSubmit={e => { e.preventDefault(); sendMessage(); }} className="flex gap-2">
                    <Input ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
                      placeholder={`Parle à ${zeusName}...`}
                      className="flex-1 rounded-xl h-10 text-sm bg-secondary/30 border-border/15 focus:border-amber-500/30 transition-colors" disabled={loading || !zeusAgentId} />
                    <Button type="submit" size="icon" disabled={!input.trim() || loading || !zeusAgentId}
                      className="h-10 w-10 rounded-xl bg-gradient-to-br from-amber-400 via-orange-500 to-red-500 hover:from-amber-500 hover:via-orange-600 hover:to-red-600 shadow-sm shadow-orange-500/20">
                      <Send className="w-4 h-4" />
                    </Button>
                  </form>
                </div>
              </>
            )}

            {activeTab === 'algo' && <AlgorithmPanel />}

            {activeTab === 'history' && (
              <div className="flex-1 overflow-y-auto">
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
                          "w-full text-left px-3.5 py-3 rounded-xl transition-all duration-200 group",
                          conversationId === conv.id ? "bg-gradient-to-r from-amber-500/8 to-orange-500/8 border border-amber-500/15" : "hover:bg-secondary/30"
                        )}>
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-medium text-foreground truncate flex-1">{conv.title || 'Conversation'}</p>
                          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors" />
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
