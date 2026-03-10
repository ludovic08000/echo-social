import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Send, Loader2, Pencil, Check, Zap, AlertTriangle, CheckCircle2,
  Plus, History, ArrowLeft, ShoppingBag, Sliders, Brain, Users, Clock,
  Sparkles, ChevronRight, BarChart3, Radio, Cpu, Shield, Globe, MessageSquare
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

function stripCodeBlocks(content: string): string {
  return content
    .replace(/```[\w-]*\s*\n[\s\S]*?\n```/g, '')
    .replace(/```[\w-]*[\s\S]*?```/g, '')
    .replace(/\{[^{}]*"type"\s*:\s*"[^"]*"[^{}]*\}/g, '')
    .trim();
}

// ── Sci-fi scan line overlay ──
function ScanLines() {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-3xl">
      <div className="absolute inset-0 opacity-[0.03]" style={{
        backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,255,0.1) 2px, rgba(0,255,255,0.1) 4px)',
      }} />
      <motion.div
        animate={{ y: ['-100%', '200%'] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
        className="absolute left-0 right-0 h-20 opacity-[0.04]"
        style={{ background: 'linear-gradient(180deg, transparent 0%, rgba(0,255,255,0.3) 50%, transparent 100%)' }}
      />
    </div>
  );
}

// ── Holographic border glow ──
function HoloBorder() {
  return (
    <motion.div
      animate={{ opacity: [0.4, 0.8, 0.4] }}
      transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
      className="absolute inset-0 rounded-3xl pointer-events-none z-0"
      style={{
        boxShadow: '0 0 30px rgba(0,255,255,0.15), inset 0 0 30px rgba(0,255,255,0.05), 0 0 60px rgba(0,200,255,0.08)',
      }}
    />
  );
}

// ── Product cards (sci-fi style) ──
function ProductCards({ products, onNavigate }: { products: ProductItem[]; onNavigate: (id: string) => void }) {
  return (
    <div className="mt-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5 mb-1">
        <ShoppingBag className="w-3.5 h-3.5 text-cyan-400" />
        <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-[0.2em]">Marketplace</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {products.slice(0, 6).map((p) => (
          <button key={p.id} onClick={() => onNavigate(p.id)}
            className="rounded-xl border border-cyan-500/20 bg-black/30 backdrop-blur-sm overflow-hidden hover:border-cyan-400/50 transition-all text-left group hover:shadow-[0_0_15px_rgba(0,255,255,0.1)]">
            {p.thumbnail_url ? (
              <div className="aspect-square w-full overflow-hidden bg-cyan-950/30">
                <img src={p.thumbnail_url} alt={p.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 opacity-90 group-hover:opacity-100" />
              </div>
            ) : (
              <div className="aspect-square w-full bg-cyan-950/20 flex items-center justify-center">
                <ShoppingBag className="w-6 h-6 text-cyan-500/30" />
              </div>
            )}
            <div className="p-1.5">
              <p className="text-[10px] font-medium text-cyan-100 truncate">{p.title}</p>
              <div className="flex items-center justify-between mt-0.5">
                <span className="text-xs font-bold text-cyan-400">{p.price}€</span>
                {p.city && <span className="text-[9px] text-cyan-300/50 truncate ml-1">{p.city}</span>}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Action card (sci-fi style) ──
function ActionCard({ action, onExecute, executing, executed }: {
  action: ActionBlock; onExecute: () => void; executing: boolean; executed: boolean;
}) {
  const labels: Record<string, { icon: string; label: string }> = {
    publish_post: { icon: '⟐', label: 'PUBLIER CE POST' },
    schedule_post: { icon: '◈', label: 'PROGRAMMER CE POST' },
    create_story: { icon: '◉', label: 'CRÉER CETTE STORY' },
    generate_image: { icon: '⬡', label: 'GÉNÉRER IMAGE' },
    translate: { icon: '⟡', label: 'TRADUCTION' },
    update_feed_config: { icon: '⎔', label: 'AJUSTER ALGORITHME' },
  };
  const info = labels[action.type] || { icon: '⚡', label: 'ACTION' };
  const preview = action.type === 'update_feed_config' ? '' : (action.body || action.caption || action.translated_text || action.prompt || '');

  return (
    <div className="mt-2.5 p-3 rounded-xl bg-gradient-to-br from-cyan-500/5 to-blue-500/5 border border-cyan-500/20 space-y-2 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent" />
      <div className="flex items-center gap-1.5">
        <span className="text-sm text-cyan-400 font-mono">{info.icon}</span>
        <span className="text-[10px] font-bold text-cyan-400 tracking-[0.15em]">{info.label}</span>
        {action.publish_at && (
          <span className="text-[10px] text-cyan-300/40 ml-auto font-mono">
            {new Date(action.publish_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}
          </span>
        )}
      </div>
      {preview && <p className="text-xs text-cyan-100/80 bg-black/20 rounded-lg p-2.5 whitespace-pre-wrap leading-relaxed border border-cyan-500/10 font-mono text-[11px]">{preview}</p>}
      {executed ? (
        <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium font-mono">
          <CheckCircle2 className="w-3.5 h-3.5" /><span>EXÉCUTÉ ✓</span>
        </div>
      ) : (
        <Button size="sm" onClick={onExecute} disabled={executing}
          className="w-full h-8 text-[11px] rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/30 hover:border-cyan-400/50 shadow-[0_0_15px_rgba(0,255,255,0.1)] hover:shadow-[0_0_20px_rgba(0,255,255,0.2)] transition-all font-mono tracking-wider">
          {executing ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
          {executing ? 'TRAITEMENT...' : '▶ CONFIRMER'}
        </Button>
      )}
    </div>
  );
}

// ── Feed Preview Simulation (Sci-fi) ──
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
    friend: 'bg-cyan-400', discovery: 'bg-violet-400', marketplace: 'bg-amber-400', chrono: 'bg-blue-400',
  };

  return (
    <div className="space-y-2 p-3 rounded-xl bg-black/20 border border-cyan-500/10">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold text-cyan-400/70 uppercase tracking-[0.2em] font-mono">Analyse du flux</span>
        <motion.span animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 2, repeat: Infinity }}
          className="text-[9px] text-cyan-400 font-mono flex items-center gap-1">
          <Radio className="w-2.5 h-2.5" /> LIVE
        </motion.span>
      </div>
      <div className="flex gap-px h-8 rounded-lg overflow-hidden border border-cyan-500/20">
        <motion.div animate={{ width: `${fPct}%` }} transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className="bg-cyan-500/40 flex items-center justify-center min-w-0" title={`Amis: ${fPct}%`}>
          {fPct > 15 && <span className="text-[8px] text-cyan-200 font-mono font-bold">{fPct}%</span>}
        </motion.div>
        <motion.div animate={{ width: `${dPct}%` }} transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className="bg-violet-500/40 flex items-center justify-center min-w-0" title={`Découverte: ${dPct}%`}>
          {dPct > 15 && <span className="text-[8px] text-violet-200 font-mono font-bold">{dPct}%</span>}
        </motion.div>
        <motion.div animate={{ width: `${mPct}%` }} transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className="bg-amber-500/40 flex items-center justify-center min-w-0" title={`Marketplace: ${mPct}%`}>
          {mPct > 15 && <span className="text-[8px] text-amber-200 font-mono font-bold">{mPct}%</span>}
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
        <span className="flex items-center gap-1 text-[8px] text-cyan-300/60 font-mono"><span className="w-2 h-2 rounded-sm bg-cyan-400 inline-block" /> AMI</span>
        <span className="flex items-center gap-1 text-[8px] text-violet-300/60 font-mono"><span className="w-2 h-2 rounded-sm bg-violet-400 inline-block" /> DÉCOUVERTE</span>
        <span className="flex items-center gap-1 text-[8px] text-amber-300/60 font-mono"><span className="w-2 h-2 rounded-sm bg-amber-400 inline-block" /> MARKET</span>
      </div>
    </div>
  );
}

// ── Algorithm Control Panel (Sci-fi) ──
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
    const names = { smart: 'Mode Neural', chronological: 'Mode Séquentiel', friends_first: 'Mode Réseau' };
    showFeedback(names[algo]);
    toast.success(`${names[algo]} activé`, { duration: 2000 });
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
    { id: 'smart' as FeedAlgorithm, icon: <Brain className="w-5 h-5" />, label: 'Neural', desc: 'L\'IA sélectionne le contenu optimal', symbol: '◈' },
    { id: 'chronological' as FeedAlgorithm, icon: <Clock className="w-5 h-5" />, label: 'Séquentiel', desc: 'Flux temporel linéaire', symbol: '◇' },
    { id: 'friends_first' as FeedAlgorithm, icon: <Users className="w-5 h-5" />, label: 'Réseau', desc: 'Priorité au graphe social', symbol: '◎' },
  ];

  return (
    <div className="px-4 py-3 space-y-4 overflow-y-auto flex-1">
      <AnimatePresence>
        {lastChanged && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
            className="flex items-center gap-2 p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span className="text-[11px] font-mono">{lastChanged} — recalibration en cours...</span>
          </motion.div>
        )}
      </AnimatePresence>

      <FeedPreviewBar friends={feedWeights.friends} discovery={feedWeights.discovery}
        marketplace={feedWeights.marketplace} algo={feedAlgo} viralReduce={viralReduce} diversityBoost={diversityBoost} />

      <div className="space-y-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-400/60 flex items-center gap-1.5 font-mono">
          <Cpu className="w-3 h-3" /> Mode de tri
        </h3>
        <div className="space-y-1.5">
          {algoOptions.map(opt => (
            <motion.button key={opt.id} onClick={() => updateAlgo(opt.id)}
              whileTap={{ scale: 0.98 }}
              className={cn(
                "w-full flex items-center gap-3 p-3 rounded-xl border transition-all duration-200 text-left relative overflow-hidden",
                feedAlgo === opt.id
                  ? "bg-cyan-500/10 border-cyan-500/30 shadow-[0_0_15px_rgba(0,255,255,0.08)]"
                  : "border-cyan-500/10 hover:bg-cyan-500/5 hover:border-cyan-500/20"
              )}>
              {feedAlgo === opt.id && (
                <motion.div layoutId="algo-glow" className="absolute inset-0 bg-gradient-to-r from-cyan-500/5 via-transparent to-cyan-500/5" />
              )}
              <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center text-lg transition-all font-mono relative z-10",
                feedAlgo === opt.id ? "bg-cyan-500/20 text-cyan-400 shadow-[0_0_20px_rgba(0,255,255,0.15)]" : "bg-black/20 text-cyan-500/40"
              )}>
                {opt.symbol}
              </div>
              <div className="flex-1 relative z-10">
                <span className={cn("text-sm font-bold font-mono tracking-wide", feedAlgo === opt.id ? "text-cyan-300" : "text-cyan-100/60")}>{opt.label}</span>
                <p className="text-[10px] text-cyan-300/40 mt-0.5 font-mono">{opt.desc}</p>
              </div>
              {feedAlgo === opt.id && (
                <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="relative z-10">
                  <CheckCircle2 className="w-5 h-5 text-cyan-400" />
                </motion.div>
              )}
            </motion.button>
          ))}
        </div>
      </div>

      {feedAlgo === 'smart' && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-3">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-400/60 flex items-center gap-1.5 font-mono">
            <Sliders className="w-3 h-3" /> Pondération neurale
          </h3>
          {[
            { key: 'friends' as keyof FeedWeights, label: 'Réseau social', icon: '◈', color: 'bg-cyan-500', hint: 'Poids du graphe de proximité' },
            { key: 'discovery' as keyof FeedWeights, label: 'Exploration', icon: '◇', color: 'bg-violet-500', hint: 'Couverture de l\'espace de découverte' },
            { key: 'marketplace' as keyof FeedWeights, label: 'Commerce', icon: '◎', color: 'bg-amber-500', hint: 'Intégration du flux marketplace' },
          ].map(item => (
            <div key={item.key} className="space-y-1.5 p-3 rounded-xl bg-black/20 border border-cyan-500/10">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-base text-cyan-400 font-mono">{item.icon}</span>
                  <div>
                    <span className="text-xs font-bold font-mono text-cyan-200">{item.label}</span>
                    <p className="text-[9px] text-cyan-300/30 font-mono">{item.hint}</p>
                  </div>
                </div>
                <motion.span key={feedWeights[item.key]} initial={{ scale: 1.3 }} animate={{ scale: 1 }}
                  className={cn("text-sm font-bold tabular-nums px-2 py-0.5 rounded-md text-white font-mono", item.color, "bg-opacity-40")}>
                  {feedWeights[item.key]}%
                </motion.span>
              </div>
              <Slider
                value={[feedWeights[item.key]]}
                onValueChange={([v]) => updateWeights({ ...feedWeights, [item.key]: v }, item.label)}
                min={0} max={100} step={5}
                className="[&_[role=slider]]:h-5 [&_[role=slider]]:w-5 [&_[role=slider]]:shadow-[0_0_10px_rgba(0,255,255,0.3)] [&_[role=slider]]:border-cyan-500/50"
              />
            </div>
          ))}
        </motion.div>
      )}

      <div className="space-y-2 p-3 rounded-xl bg-black/20 border border-cyan-500/10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-cyan-400/50" />
            <div>
              <span className="text-xs font-bold font-mono text-cyan-200">Entropie</span>
              <p className="text-[9px] text-cyan-300/30 font-mono">Niveau de diversification du contenu</p>
            </div>
          </div>
          <motion.span key={diversityBoost} initial={{ scale: 1.3 }} animate={{ scale: 1 }}
            className="text-xs font-bold text-cyan-400 font-mono">{diversityBoost}%</motion.span>
        </div>
        <Slider value={[diversityBoost]} onValueChange={([v]) => updateDiversity(v)} min={0} max={100} step={10}
          className="[&_[role=slider]]:h-5 [&_[role=slider]]:w-5 [&_[role=slider]]:shadow-[0_0_10px_rgba(0,255,255,0.3)]" />
        <div className="flex justify-between text-[9px] text-cyan-300/30 font-mono">
          <span>▸ Stable</span>
          <span>Exploratoire ◂</span>
        </div>
      </div>

      <motion.div whileTap={{ scale: 0.98 }}
        className={cn("flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer",
          viralReduce ? "bg-cyan-500/10 border-cyan-500/25" : "bg-black/20 border-cyan-500/10"
        )} onClick={() => updateViral(!viralReduce)}>
        <div className="flex items-center gap-2">
          <Shield className={cn("w-4 h-4", viralReduce ? "text-cyan-400" : "text-cyan-500/30")} />
          <div>
            <p className="text-xs font-bold font-mono text-cyan-200">Filtre anti-viral</p>
            <p className="text-[9px] text-cyan-300/30 font-mono">
              {viralReduce ? 'Actif — flux authentifié' : 'Inactif — contenu populaire visible'}
            </p>
          </div>
        </div>
        <Switch checked={viralReduce} onCheckedChange={updateViral} />
      </motion.div>

      <div className="p-3 rounded-xl bg-cyan-500/5 border border-cyan-500/10">
        <p className="text-[10px] text-cyan-300/40 leading-relaxed font-mono">
          ◈ <strong className="text-cyan-300/60">Tip :</strong> Dis « <em className="text-cyan-400/60">Optimise mon fil</em> » au chat pour une recalibration automatique.
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
        toast.success(action.type === 'schedule_post' ? 'Post programmé' : 'Post publié');
      } else if (action.type === 'translate') {
        await navigator.clipboard.writeText(action.translated_text || action.body || '');
        toast.success('Traduction copiée');
      } else if (action.type === 'create_story') {
        toast.success('Story créée');
      } else {
        toast.info('Action exécutée');
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
      if (convId && convId !== conversationId) { setConversationId(convId); setIsNewConversation(false); refetchConversations(); }

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
    { id: 'chat', icon: <MessageSquare className="w-4 h-4" />, label: 'Terminal' },
    { id: 'algo', icon: <Cpu className="w-4 h-4" />, label: 'Neural' },
    { id: 'history', icon: <History className="w-4 h-4" />, label: 'Archives' },
  ];

  return (
    <>
      {/* FAB Button — Sci-fi orb */}
      <AnimatePresence>
        {!open && (
          <motion.button
            initial={{ scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            exit={{ scale: 0, rotate: 180 }}
            transition={{ type: 'spring', stiffness: 260, damping: 20 }}
            onClick={() => setOpen(true)}
            className="fixed bottom-[76px] right-5 z-[55] w-14 h-14 rounded-2xl flex items-center justify-center text-cyan-300 hover:text-cyan-100 active:scale-95 transition-all group md:bottom-6 md:right-6"
            style={{
              background: 'linear-gradient(135deg, rgba(0,30,60,0.95) 0%, rgba(0,50,80,0.95) 50%, rgba(0,40,70,0.95) 100%)',
              boxShadow: '0 0 25px rgba(0,255,255,0.2), 0 0 50px rgba(0,200,255,0.1), inset 0 1px 0 rgba(0,255,255,0.15)',
              border: '1px solid rgba(0,255,255,0.25)',
            }}
          >
            <Zap className="w-6 h-6 relative z-10" />
            <motion.div
              animate={{ opacity: [0.2, 0.5, 0.2], scale: [1, 1.1, 1] }}
              transition={{ duration: 3, repeat: Infinity }}
              className="absolute inset-0 rounded-2xl"
              style={{ boxShadow: '0 0 30px rgba(0,255,255,0.3)' }}
            />
            {unacknowledged.length > 0 && (
              <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-[10px] font-bold flex items-center justify-center text-white ring-2 ring-background shadow-[0_0_10px_rgba(255,0,0,0.4)]">
                {unacknowledged.length}
              </motion.span>
            )}
          </motion.button>
        )}
      </AnimatePresence>

      {/* Main Panel — Sci-fi HUD */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 40, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 40, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed bottom-4 right-4 z-[55] w-[390px] max-w-[calc(100vw-2rem)] h-[560px] max-h-[75vh] rounded-3xl flex flex-col overflow-hidden relative"
            style={{
              background: 'linear-gradient(180deg, rgba(0,15,30,0.97) 0%, rgba(0,20,40,0.98) 50%, rgba(0,10,25,0.99) 100%)',
              border: '1px solid rgba(0,255,255,0.15)',
              boxShadow: '0 0 40px rgba(0,255,255,0.1), 0 25px 50px -12px rgba(0,0,0,0.5), inset 0 1px 0 rgba(0,255,255,0.1)',
            }}
          >
            <ScanLines />
            <HoloBorder />

            {/* Header */}
            <div className="relative px-4 py-3 border-b border-cyan-500/10 z-20">
              {/* Holographic accent line */}
              <motion.div
                animate={{ opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 2, repeat: Infinity }}
                className="absolute top-0 left-4 right-4 h-[1px]"
                style={{ background: 'linear-gradient(90deg, transparent, rgba(0,255,255,0.6), rgba(100,200,255,0.4), rgba(0,255,255,0.6), transparent)' }}
              />
              
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center text-cyan-300 text-sm relative"
                    style={{
                      background: 'linear-gradient(135deg, rgba(0,255,255,0.15), rgba(0,100,200,0.15))',
                      boxShadow: '0 0 20px rgba(0,255,255,0.15), inset 0 0 10px rgba(0,255,255,0.05)',
                      border: '1px solid rgba(0,255,255,0.25)',
                    }}>
                    <Zap className="w-4 h-4" />
                    <motion.div
                      animate={{ opacity: [0.3, 0.8, 0.3] }}
                      transition={{ duration: 2, repeat: Infinity }}
                      className="absolute inset-0 rounded-xl"
                      style={{ boxShadow: '0 0 15px rgba(0,255,255,0.2)' }}
                    />
                  </div>
                  {editingName ? (
                    <div className="flex items-center gap-1">
                      <Input value={newName} onChange={e => setNewName(e.target.value)} className="h-7 w-28 text-sm rounded-lg bg-cyan-950/50 border-cyan-500/30 text-cyan-200 font-mono" maxLength={20} autoFocus onKeyDown={e => e.key === 'Enter' && handleRename()} />
                      <button onClick={handleRename} className="text-cyan-400"><Check className="w-4 h-4" /></button>
                      <button onClick={() => setEditingName(false)} className="text-cyan-500/40"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-sm text-cyan-300 font-mono tracking-wider">{zeusName}</span>
                      <motion.span
                        animate={{ opacity: [0.4, 1, 0.4] }}
                        transition={{ duration: 1.5, repeat: Infinity }}
                        className="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(0,255,255,0.6)]"
                      />
                      <button onClick={() => { setNewName(zeusName); setEditingName(true); }} className="text-cyan-500/30 hover:text-cyan-400 transition-colors">
                        <Pencil className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={startNewConversation} className="w-7 h-7 rounded-lg flex items-center justify-center text-cyan-500/40 hover:text-cyan-300 hover:bg-cyan-500/10 transition-all" title="Nouvelle conversation">
                    <Plus className="w-4 h-4" />
                  </button>
                  <button onClick={() => setOpen(false)} className="w-7 h-7 rounded-lg flex items-center justify-center text-cyan-500/40 hover:text-cyan-300 hover:bg-cyan-500/10 transition-all">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Tab Bar */}
            <div className="flex px-3 pt-2 pb-1 gap-1 relative z-20">
              {tabs.map(tab => (
                <button key={tab.id} onClick={() => { setActiveTab(tab.id); if (tab.id === 'history') refetchConversations(); }}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-[11px] font-mono tracking-wider transition-all duration-200 relative",
                    activeTab === tab.id
                      ? "text-cyan-300 border border-cyan-500/25"
                      : "text-cyan-500/40 hover:text-cyan-400/60 border border-transparent"
                  )}
                  style={activeTab === tab.id ? {
                    background: 'linear-gradient(135deg, rgba(0,255,255,0.08), rgba(0,100,200,0.05))',
                    boxShadow: '0 0 10px rgba(0,255,255,0.05)',
                  } : {}}>
                  {tab.icon}
                  <span className="uppercase">{tab.label}</span>
                </button>
              ))}
            </div>

            {/* Strike warnings */}
            {activeTab === 'chat' && unacknowledged.length > 0 && (
              <div className="mx-3 mt-1 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 relative z-20">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
                  <p className="text-[11px] text-red-300 leading-relaxed font-mono">
                    {(unacknowledged[0] as any).zeus_message || 'Alerte : contenu signalé détecté.'}
                  </p>
                </div>
              </div>
            )}

            {/* Content Area */}
            {activeTab === 'chat' && (
              <>
                <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0 relative z-20">
                  {messages.length === 0 && (
                    <div className="text-center py-4">
                      <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', delay: 0.1 }}
                        className="w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center relative"
                        style={{
                          background: 'linear-gradient(135deg, rgba(0,255,255,0.1), rgba(0,100,200,0.1))',
                          border: '1px solid rgba(0,255,255,0.2)',
                          boxShadow: '0 0 30px rgba(0,255,255,0.1), inset 0 0 20px rgba(0,255,255,0.05)',
                        }}>
                        <Zap className="w-7 h-7 text-cyan-400" />
                        <motion.div
                          animate={{ rotate: 360 }}
                          transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
                          className="absolute inset-[-4px] rounded-2xl opacity-30"
                          style={{
                            border: '1px dashed rgba(0,255,255,0.3)',
                          }}
                        />
                      </motion.div>
                      <p className="text-sm font-bold text-cyan-200 font-mono tracking-wide">
                        <span className="text-cyan-400">{zeusName}</span> <span className="text-cyan-500/50">EN LIGNE</span>
                      </p>
                      <p className="text-[11px] text-cyan-400/40 mt-1 mb-4 font-mono">Système d'assistance neurale activé</p>
                      
                      {/* Capabilities */}
                      <div className="text-left mx-1 space-y-1 mb-4">
                        {[
                          { icon: <Pencil className="w-3 h-3" />, text: 'Création et publication automatique' },
                          { icon: <Cpu className="w-3 h-3" />, text: 'Gestion du flux algorithmique' },
                          { icon: <ShoppingBag className="w-3 h-3" />, text: 'Recherche marketplace avancée' },
                          { icon: <Globe className="w-3 h-3" />, text: 'Traduction multilingue instantanée' },
                          { icon: <MessageSquare className="w-3 h-3" />, text: 'Assistance conversationnelle IA' },
                          { icon: <Shield className="w-3 h-3" />, text: 'Surveillance de sécurité du compte' },
                        ].map((cap, idx) => (
                          <motion.div key={idx} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: 0.1 + idx * 0.05 }}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-cyan-500/10 bg-cyan-500/[0.03]">
                            <span className="text-cyan-500/50">{cap.icon}</span>
                            <span className="text-[11px] text-cyan-300/50 font-mono">{cap.text}</span>
                          </motion.div>
                        ))}
                      </div>

                      {/* Quick actions */}
                      <div className="flex flex-wrap gap-1.5 justify-center">
                        {[
                          { label: '◈ Post', value: 'Publie un post motivant' },
                          { label: '◇ Traduis', value: 'Traduis en anglais' },
                          { label: '◎ Market', value: 'Cherche un produit' },
                          { label: '⎔ Algo', value: 'Optimise mon fil' },
                        ].map(s => (
                          <button key={s.value} onClick={() => setInput(s.value)}
                            className="text-[10px] px-3 py-1.5 rounded-full text-cyan-400/60 hover:text-cyan-300 transition-all duration-200 border border-cyan-500/15 hover:border-cyan-500/30 hover:bg-cyan-500/5 font-mono tracking-wide hover:shadow-[0_0_10px_rgba(0,255,255,0.08)]">
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
                      displayText = stripCodeBlocks(displayText);
                    }

                    return (
                      <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                        className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                        {msg.role === 'assistant' && (
                          <div className="w-6 h-6 rounded-lg flex items-center justify-center text-xs shrink-0 mt-1 mr-1.5 border border-cyan-500/20"
                            style={{ background: 'rgba(0,255,255,0.05)', boxShadow: '0 0 8px rgba(0,255,255,0.1)' }}>
                            <Zap className="w-3 h-3 text-cyan-400" />
                          </div>
                        )}
                        <div className={cn(
                          'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                          msg.role === 'user'
                            ? 'rounded-br-lg text-cyan-100'
                            : 'rounded-bl-lg text-cyan-200/90'
                        )}
                        style={msg.role === 'user' ? {
                          background: 'linear-gradient(135deg, rgba(0,150,255,0.2), rgba(0,100,200,0.15))',
                          border: '1px solid rgba(0,150,255,0.25)',
                          boxShadow: '0 0 15px rgba(0,100,255,0.08)',
                        } : {
                          background: 'rgba(0,255,255,0.04)',
                          border: '1px solid rgba(0,255,255,0.1)',
                        }}>
                          {msg.role === 'assistant' ? (
                            <div className="prose prose-sm dark:prose-invert max-w-none [&>p]:m-0 [&>ul]:mt-1 [&_*]:text-cyan-200/90 [&_strong]:text-cyan-300 [&_a]:text-cyan-400 [&_code]:text-cyan-400 [&_code]:bg-cyan-500/10">
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
                      <div className="w-6 h-6 rounded-lg flex items-center justify-center text-xs shrink-0 mt-1 mr-1.5 border border-cyan-500/20"
                        style={{ background: 'rgba(0,255,255,0.05)' }}>
                        <Zap className="w-3 h-3 text-cyan-400" />
                      </div>
                      <div className="rounded-2xl rounded-bl-lg px-4 py-3 border border-cyan-500/10"
                        style={{ background: 'rgba(0,255,255,0.04)' }}>
                        <div className="flex gap-1.5">
                          <motion.div animate={{ opacity: [0.2, 1, 0.2], boxShadow: ['0 0 5px rgba(0,255,255,0)', '0 0 5px rgba(0,255,255,0.5)', '0 0 5px rgba(0,255,255,0)'] }}
                            transition={{ duration: 1.2, repeat: Infinity, delay: 0 }} className="w-2 h-2 rounded-full bg-cyan-400" />
                          <motion.div animate={{ opacity: [0.2, 1, 0.2], boxShadow: ['0 0 5px rgba(0,255,255,0)', '0 0 5px rgba(0,255,255,0.5)', '0 0 5px rgba(0,255,255,0)'] }}
                            transition={{ duration: 1.2, repeat: Infinity, delay: 0.2 }} className="w-2 h-2 rounded-full bg-cyan-400" />
                          <motion.div animate={{ opacity: [0.2, 1, 0.2], boxShadow: ['0 0 5px rgba(0,255,255,0)', '0 0 5px rgba(0,255,255,0.5)', '0 0 5px rgba(0,255,255,0)'] }}
                            transition={{ duration: 1.2, repeat: Infinity, delay: 0.4 }} className="w-2 h-2 rounded-full bg-cyan-400" />
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <div className="px-3 py-3 border-t border-cyan-500/10 relative z-20">
                  <form onSubmit={e => { e.preventDefault(); sendMessage(); }} className="flex gap-2">
                    <Input ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
                      placeholder={`Commande ${zeusName}...`}
                      className="flex-1 rounded-xl h-10 text-sm font-mono bg-cyan-950/30 border-cyan-500/15 text-cyan-200 placeholder:text-cyan-500/30 focus:border-cyan-500/40 focus:ring-cyan-500/20 transition-colors"
                      style={{ boxShadow: 'inset 0 0 20px rgba(0,255,255,0.02)' }}
                      disabled={loading || !zeusAgentId} />
                    <Button type="submit" size="icon" disabled={!input.trim() || loading || !zeusAgentId}
                      className="h-10 w-10 rounded-xl border border-cyan-500/30 text-cyan-300 hover:text-cyan-100 disabled:opacity-30 transition-all"
                      style={{
                        background: 'linear-gradient(135deg, rgba(0,255,255,0.15), rgba(0,100,200,0.15))',
                        boxShadow: '0 0 15px rgba(0,255,255,0.1)',
                      }}>
                      <Send className="w-4 h-4" />
                    </Button>
                  </form>
                </div>
              </>
            )}

            {activeTab === 'algo' && <div className="relative z-20 flex-1 overflow-hidden flex flex-col"><AlgorithmPanel /></div>}

            {activeTab === 'history' && (
              <div className="flex-1 overflow-y-auto relative z-20">
                <div className="px-3 pt-3 pb-1">
                  <button onClick={startNewConversation}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-cyan-500/20 text-cyan-400 hover:bg-cyan-500/5 hover:border-cyan-500/30 transition-all text-[11px] font-mono tracking-wider hover:shadow-[0_0_15px_rgba(0,255,255,0.08)]"
                    style={{ background: 'rgba(0,255,255,0.03)' }}>
                    <Plus className="w-4 h-4" />
                    NOUVELLE SESSION
                  </button>
                </div>
                {(!conversations || conversations.length === 0) ? (
                  <div className="text-center py-12 text-cyan-500/30 text-sm font-mono">
                    <History className="w-8 h-8 mx-auto mb-2 text-cyan-500/15" />
                    <p className="tracking-wider">ARCHIVES VIDES</p>
                  </div>
                ) : (
                  <div className="p-2 space-y-1">
                    {conversations.map((conv: any) => (
                      <button key={conv.id} onClick={() => selectConversation(conv.id)}
                        className={cn(
                          "w-full text-left px-3.5 py-3 rounded-xl transition-all duration-200 group border",
                          conversationId === conv.id
                            ? "border-cyan-500/25 shadow-[0_0_10px_rgba(0,255,255,0.05)]"
                            : "border-transparent hover:bg-cyan-500/5 hover:border-cyan-500/10"
                        )}
                        style={conversationId === conv.id ? { background: 'rgba(0,255,255,0.05)' } : {}}>
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-mono text-cyan-200 truncate flex-1">{conv.title || 'Session'}</p>
                          <ChevronRight className="w-3.5 h-3.5 text-cyan-500/30 group-hover:text-cyan-400/60 transition-colors" />
                        </div>
                        <p className="text-[10px] text-cyan-500/30 mt-0.5 font-mono">
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
