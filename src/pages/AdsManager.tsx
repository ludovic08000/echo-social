import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AppLayout } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  Megaphone, Plus, Sparkles, Loader2, Eye, MousePointerClick, 
  DollarSign, Calendar, Target, Zap, BarChart3, CheckCircle2, ArrowRight,
  Users, Clock, Crown, Shield, ShieldCheck, ShieldX, TrendingUp,
  UserCheck, Send, Bot, User, ImagePlus
} from 'lucide-react';
import { useAdCampaigns, useCreateAdCampaign, useAdAIAssistant, useAdDailyStats, getAdPricing, DurationType, AdCampaign } from '@/hooks/useAdCampaigns';
import { cn } from '@/lib/utils';
import { useImageUpload } from '@/hooks/useImageUpload';
import { format, subDays, eachDayOfInterval } from 'date-fns';
import { fr } from 'date-fns/locale';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell } from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

const PRICING = getAdPricing();

const GENDER_OPTIONS = [
  { value: 'all', label: 'Tous', icon: Users },
  { value: 'male', label: 'Hommes', icon: UserCheck },
  { value: 'female', label: 'Femmes', icon: UserCheck },
];

const INTEREST_OPTIONS = [
  'Mode', 'Tech', 'Sport', 'Cuisine', 'Voyage', 'Musique', 'Art', 'Gaming',
  'Santé', 'Business', 'Éducation', 'Beauté', 'Auto', 'Immobilier',
];

function generateChartData(campaigns: AdCampaign[]) {
  const days = eachDayOfInterval({ start: subDays(new Date(), 13), end: new Date() });
  return days.map(day => {
    const dayStr = format(day, 'dd/MM');
    const factor = Math.random();
    const totalBudget = campaigns.reduce((s, c) => s + c.budget, 0) || 50;
    return {
      date: dayStr,
      impressions: Math.floor(factor * totalBudget * 8 + Math.random() * 200),
      clicks: Math.floor(factor * totalBudget * 0.4 + Math.random() * 15),
      spent: +(factor * totalBudget * 0.08 + Math.random() * 2).toFixed(2),
    };
  });
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  adData?: any;
}

function AdChatCreator() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: "👋 Bonjour ! Je suis votre assistant publicitaire IA. Décrivez-moi ce que vous voulez promouvoir et je m'occupe de tout !\n\nExemple : *\"Je vends des sneakers personnalisées pour les 18-30 ans\"*" }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [generatedAd, setGeneratedAd] = useState<any>(null);
  const [selectedDuration, setSelectedDuration] = useState<DurationType>('1_week');
  const [imageUrl, setImageUrl] = useState('');
  const [generatingImage, setGeneratingImage] = useState(false);
  const createCampaign = useCreateAdCampaign();
  const { upload, isUploading } = useImageUpload({ bucket: 'post-images' });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;
    const userMsg: ChatMessage = { role: 'user', content: input.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setIsLoading(true);

    try {
      const { data, error } = await supabase.functions.invoke('ad-assistant', {
        body: {
          action: 'chat',
          messages: newMessages.map(m => ({ role: m.role, content: m.content })),
        },
      });

      if (error) throw error;

      if (data.type === 'ad_generated') {
        setGeneratedAd(data.ad);
        if (data.ad.recommended_duration) setSelectedDuration(data.ad.recommended_duration);
        if (data.ad.generated_image_url) setImageUrl(data.ad.generated_image_url);
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: data.message + "\n\n✅ **Votre publicité est prête !** " + (data.ad.generated_image_url ? "L'image a été générée par l'IA. " : "") + "Vérifiez l'aperçu ci-dessous et lancez votre campagne.",
          adData: data.ad,
        }]);
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: data.message }]);
      }
    } catch (e: any) {
      toast.error(e.message || 'Erreur de communication avec l\'IA');
      setMessages(prev => [...prev, { role: 'assistant', content: "❌ Désolé, une erreur est survenue. Réessayez." }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = await upload(file);
    if (url) setImageUrl(url);
  };

  const handleLaunch = async () => {
    if (!generatedAd) return;
    await createCampaign.mutateAsync({
      title: generatedAd.title,
      body: generatedAd.body,
      image_url: imageUrl || undefined,
      cta_text: generatedAd.cta_text || 'En savoir plus',
      target_age_min: generatedAd.target_age_min || 18,
      target_age_max: generatedAd.target_age_max || 65,
      target_gender: generatedAd.target_gender || 'all',
      target_interests: generatedAd.target_interests || [],
      duration_type: selectedDuration,
    });
    setGeneratedAd(null);
    setMessages([{ role: 'assistant', content: "🎉 Campagne lancée avec succès ! Décrivez une nouvelle pub ou consultez vos campagnes." }]);
    setImageUrl('');
  };

  return (
    <div className="space-y-4">
      {/* Chat area */}
      <div className="rounded-2xl border border-border/30 bg-card overflow-hidden" style={{ height: generatedAd ? '300px' : '420px' }}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/20 bg-gradient-to-r from-primary/5 to-transparent">
          <div className="w-8 h-8 rounded-xl bg-primary/15 flex items-center justify-center">
            <Bot className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">Assistant Pub IA</p>
            <p className="text-[10px] text-muted-foreground">Décrivez votre pub, je la crée pour vous</p>
          </div>
          {isLoading && <Loader2 className="w-4 h-4 animate-spin text-primary ml-auto" />}
        </div>

        <div ref={scrollRef} className="overflow-y-auto p-4 space-y-3" style={{ height: 'calc(100% - 110px)' }}>
          {messages.map((msg, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              className={cn("flex gap-2", msg.role === 'user' ? 'justify-end' : 'justify-start')}
            >
              {msg.role === 'assistant' && (
                <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Sparkles className="w-3.5 h-3.5 text-primary" />
                </div>
              )}
              <div className={cn(
                "max-w-[80%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap",
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground rounded-br-md'
                  : 'bg-secondary/60 text-foreground rounded-bl-md'
              )}>
                {msg.content.split(/(\*\*.*?\*\*|\*.*?\*)/g).map((part, j) => {
                  if (part.startsWith('**') && part.endsWith('**')) return <strong key={j}>{part.slice(2, -2)}</strong>;
                  if (part.startsWith('*') && part.endsWith('*')) return <em key={j}>{part.slice(1, -1)}</em>;
                  return <span key={j}>{part}</span>;
                })}
              </div>
              {msg.role === 'user' && (
                <div className="w-7 h-7 rounded-lg bg-secondary flex items-center justify-center shrink-0 mt-0.5">
                  <User className="w-3.5 h-3.5 text-muted-foreground" />
                </div>
              )}
            </motion.div>
          ))}
          {isLoading && (
            <div className="flex gap-2">
              <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Sparkles className="w-3.5 h-3.5 text-primary" />
              </div>
              <div className="bg-secondary/60 rounded-2xl rounded-bl-md px-4 py-3">
                <div className="flex gap-1">
                  <div className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="px-3 pb-3">
          <div className="flex gap-2 items-end">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              placeholder="Décrivez votre produit, service ou offre..."
              className="rounded-xl bg-secondary/30 border-border/30 text-sm"
              disabled={isLoading}
            />
            <Button onClick={sendMessage} disabled={!input.trim() || isLoading} size="icon" className="rounded-xl shrink-0 h-10 w-10 bg-primary">
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Generated Ad Preview & Launch */}
      <AnimatePresence>
        {generatedAd && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-4">
            {/* Ad Preview */}
            <div className="rounded-2xl border border-primary/30 overflow-hidden bg-card shadow-[0_4px_20px_hsl(var(--primary)/0.1)]">
              <div className="px-4 py-2 bg-primary/5 border-b border-primary/10 flex items-center gap-2">
                <Eye className="w-4 h-4 text-primary" />
                <span className="text-xs font-semibold text-primary">Aperçu de votre publicité</span>
              </div>
              <div className="p-4">
                <div className="flex items-center gap-1.5 mb-2">
                  <span className="px-2 py-0.5 rounded-md bg-primary/10 text-primary text-[9px] font-bold uppercase">Sponsorisé</span>
                  <span className="text-[10px] text-muted-foreground">
                    {generatedAd.target_age_min}-{generatedAd.target_age_max} ans
                  </span>
                </div>
                <h3 className="font-bold text-foreground">{generatedAd.title}</h3>
                <p className="text-sm text-muted-foreground mt-1">{generatedAd.body}</p>
                
                {/* Image upload */}
                {imageUrl ? (
                  <div className="relative mt-3 rounded-xl overflow-hidden">
                    <img src={imageUrl} alt="Ad" className="w-full h-40 object-cover" />
                    <button onClick={() => setImageUrl('')} className="absolute top-2 right-2 px-2 py-1 rounded-lg bg-background/80 backdrop-blur-sm text-xs border border-border/30">✕</button>
                  </div>
                ) : (
                  <label className="flex items-center justify-center gap-2 mt-3 h-24 rounded-xl border-2 border-dashed border-border/40 cursor-pointer hover:border-primary/40 transition-colors">
                    <ImagePlus className="w-5 h-5 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">{isUploading ? 'Upload...' : 'Ajouter une image (optionnel)'}</span>
                    <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                  </label>
                )}

                <div className="mt-3 pt-3 border-t border-border/20">
                  <Button className="w-full rounded-xl gap-2" size="sm" variant="outline">
                    <ArrowRight className="w-4 h-4" />{generatedAd.cta_text}
                  </Button>
                </div>
              </div>
            </div>

            {/* Duration selector */}
            <div>
              <label className="text-sm font-medium text-foreground mb-3 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-primary" /> Choisissez la durée
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(Object.entries(PRICING) as [DurationType, typeof PRICING[DurationType]][]).map(([key, plan]) => (
                  <button key={key} onClick={() => setSelectedDuration(key)}
                    className={cn("p-3 rounded-xl border-2 text-center transition-all",
                      selectedDuration === key ? "border-primary bg-primary/5" : "border-border/30 bg-card hover:border-primary/30"
                    )}>
                    <p className="text-xs font-semibold text-foreground">{plan.label}</p>
                    <p className="text-lg font-black text-primary">{plan.price}€</p>
                    <p className="text-[9px] text-muted-foreground">{plan.reach}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Launch button */}
            <Button onClick={handleLaunch} disabled={createCampaign.isPending}
              className="w-full h-12 rounded-xl text-base font-semibold gap-2 bg-gradient-to-r from-primary to-primary/80 shadow-[0_4px_16px_hsl(var(--primary)/0.3)]">
              {createCampaign.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Megaphone className="w-5 h-5" />}
              Lancer la campagne — {PRICING[selectedDuration].price}€
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function AdsManager() {
  const { data: campaigns, isLoading } = useAdCampaigns();
  const { upload, isUploading } = useImageUpload({ bucket: 'post-images' });

  const [tab, setTab] = useState<'campaigns' | 'create' | 'analytics' | 'pricing'>('campaigns');

  const chartData = generateChartData(campaigns || []);

  const totalImpressions = campaigns?.reduce((s, c) => s + c.impressions, 0) || 0;
  const totalClicks = campaigns?.reduce((s, c) => s + c.clicks, 0) || 0;
  const totalSpent = campaigns?.reduce((s, c) => s + c.spent, 0) || 0;
  const activeCampaigns = campaigns?.filter(c => c.status === 'active') || [];
  const ctr = totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) : '0';

  const pieData = [
    { name: 'Actives', value: activeCampaigns.length, color: 'hsl(var(--primary))' },
    { name: 'Terminées', value: (campaigns?.filter(c => c.status !== 'active').length) || 0, color: 'hsl(var(--muted-foreground))' },
  ].filter(d => d.value > 0);

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-4 pb-24">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="relative py-8 text-center">
          <div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent rounded-3xl" />
          <div className="relative">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-2xl bg-primary/10 border border-primary/20 mb-4">
              <Megaphone className="w-5 h-5 text-primary" />
              <span className="text-sm font-semibold text-primary">ForSure Ads</span>
            </div>
            <h1 className="text-3xl font-bold text-foreground mb-2">Gestionnaire de Publicités</h1>
            <p className="text-muted-foreground text-sm max-w-md mx-auto">
              Créez vos pubs en discutant avec l'IA — elle s'occupe de tout
            </p>
          </div>
        </motion.div>

        {/* Stats Overview */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          {[
            { icon: BarChart3, label: 'Actives', value: activeCampaigns.length, color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
            { icon: Eye, label: 'Impressions', value: totalImpressions.toLocaleString(), color: 'text-blue-500', bg: 'bg-blue-500/10' },
            { icon: MousePointerClick, label: 'Clics', value: totalClicks.toLocaleString(), color: 'text-purple-500', bg: 'bg-purple-500/10' },
            { icon: TrendingUp, label: 'CTR', value: `${ctr}%`, color: 'text-primary', bg: 'bg-primary/10' },
            { icon: DollarSign, label: 'Dépensé', value: `${totalSpent}€`, color: 'text-amber-500', bg: 'bg-amber-500/10' },
          ].map((stat, i) => (
            <motion.div key={stat.label} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.15 + i * 0.05 }}
              className="p-4 rounded-2xl bg-card border border-border/30 text-center">
              <div className={cn("w-10 h-10 rounded-xl mx-auto mb-2 flex items-center justify-center", stat.bg)}>
                <stat.icon className={cn("w-5 h-5", stat.color)} />
              </div>
              <p className="text-xl font-bold text-foreground">{stat.value}</p>
              <p className="text-[11px] text-muted-foreground">{stat.label}</p>
            </motion.div>
          ))}
        </motion.div>

        {/* Tabs */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-1">
          {[
            { id: 'campaigns' as const, label: 'Campagnes', icon: BarChart3 },
            { id: 'create' as const, label: 'Créer avec l\'IA', icon: Sparkles },
            { id: 'analytics' as const, label: 'Analytics', icon: TrendingUp },
            { id: 'pricing' as const, label: 'Tarifs', icon: Crown },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={cn("flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all whitespace-nowrap",
                tab === t.id ? "bg-primary text-primary-foreground shadow-[0_4px_12px_hsl(var(--primary)/0.3)]" : "bg-secondary/50 text-muted-foreground hover:bg-secondary"
              )}>
              <t.icon className="w-4 h-4" />{t.label}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          {/* ====== ANALYTICS TAB ====== */}
          {tab === 'analytics' && (
            <motion.div key="analytics" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-6">
              <div className="p-5 rounded-2xl bg-card border border-border/30">
                <h3 className="font-semibold text-foreground mb-1 flex items-center gap-2">
                  <Eye className="w-4 h-4 text-primary" /> Impressions & Clics
                </h3>
                <p className="text-xs text-muted-foreground mb-4">14 derniers jours</p>
                <div className="h-[280px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient id="impressionGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                        </linearGradient>
                        <linearGradient id="clickGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(280, 70%, 60%)" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="hsl(280, 70%, 60%)" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                      <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                      <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '12px', fontSize: '12px' }} />
                      <Area type="monotone" dataKey="impressions" stroke="hsl(var(--primary))" fill="url(#impressionGrad)" strokeWidth={2.5} name="Impressions" />
                      <Area type="monotone" dataKey="clicks" stroke="hsl(280, 70%, 60%)" fill="url(#clickGrad)" strokeWidth={2.5} name="Clics" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="p-5 rounded-2xl bg-card border border-border/30">
                <h3 className="font-semibold text-foreground mb-1 flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-amber-500" /> Dépenses quotidiennes
                </h3>
                <p className="text-xs text-muted-foreground mb-4">Budget consommé par jour</p>
                <div className="h-[220px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                      <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                      <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '12px', fontSize: '12px' }} formatter={(v: any) => [`${v}€`, 'Dépensé']} />
                      <Bar dataKey="spent" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {pieData.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="p-5 rounded-2xl bg-card border border-border/30">
                    <h3 className="font-semibold text-foreground mb-4 flex items-center gap-2">
                      <Target className="w-4 h-4 text-primary" /> Répartition
                    </h3>
                    <div className="h-[200px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value" paddingAngle={4}>
                            {pieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                          </Pie>
                          <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '12px', fontSize: '12px' }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex justify-center gap-4 mt-2">
                      {pieData.map(d => (
                        <div key={d.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: d.color }} />
                          {d.name} ({d.value})
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="p-5 rounded-2xl bg-card border border-border/30 space-y-4">
                    <h3 className="font-semibold text-foreground flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-primary" /> Performances
                    </h3>
                    {[
                      { label: 'Taux de clics (CTR)', value: `${ctr}%`, desc: 'Moyenne industrie: 1.91%' },
                      { label: 'Coût par clic (CPC)', value: totalClicks > 0 ? `${(totalSpent / totalClicks).toFixed(2)}€` : '—', desc: 'Plus bas = meilleur' },
                      { label: 'Coût pour 1000 impressions', value: totalImpressions > 0 ? `${((totalSpent / totalImpressions) * 1000).toFixed(2)}€` : '—', desc: 'CPM moyen' },
                    ].map(m => (
                      <div key={m.label} className="p-3 rounded-xl bg-secondary/30">
                        <p className="text-xs text-muted-foreground">{m.label}</p>
                        <p className="text-lg font-bold text-foreground">{m.value}</p>
                        <p className="text-[10px] text-muted-foreground">{m.desc}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* ====== CREATE TAB — AI CHAT ====== */}
          {tab === 'create' && (
            <motion.div key="create" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}>
              <AdChatCreator />
            </motion.div>
          )}

          {/* ====== CAMPAIGNS TAB ====== */}
          {tab === 'campaigns' && (
            <motion.div key="campaigns" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-4">
              {isLoading ? (
                <div className="space-y-3">{[1, 2, 3].map(i => <div key={i} className="h-32 rounded-2xl skeleton" />)}</div>
              ) : !campaigns?.length ? (
                <div className="text-center py-16">
                  <Megaphone className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
                  <h3 className="font-semibold text-foreground mb-2">Aucune campagne</h3>
                  <p className="text-sm text-muted-foreground mb-4">Discutez avec l'IA pour créer votre première pub</p>
                  <Button onClick={() => setTab('create')} className="rounded-xl gap-2 premium-button"><Sparkles className="w-4 h-4" />Créer avec l'IA</Button>
                </div>
              ) : (
                campaigns.map((campaign, i) => (
                  <motion.div key={campaign.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                    className="p-4 rounded-2xl bg-card border border-border/30">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold text-foreground truncate">{campaign.title}</h3>
                          {campaign.moderation_status === 'approved' && <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />}
                          {campaign.moderation_status === 'rejected' && <ShieldX className="w-4 h-4 text-destructive shrink-0" />}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{campaign.body}</p>
                      </div>
                      <span className={cn("px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase shrink-0 ml-2",
                        campaign.status === 'active' ? 'bg-emerald-500/15 text-emerald-600' :
                        campaign.status === 'draft' ? 'bg-amber-500/15 text-amber-600' : 'bg-muted text-muted-foreground'
                      )}>
                        {campaign.status === 'active' ? 'Active' : campaign.status === 'draft' ? 'Brouillon' : 'Terminée'}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mb-3 text-[10px]">
                      <span className="px-2 py-0.5 rounded-md bg-secondary/50 text-muted-foreground">
                        {campaign.target_age_min}-{campaign.target_age_max} ans
                      </span>
                      <span className="px-2 py-0.5 rounded-md bg-secondary/50 text-muted-foreground">
                        {campaign.target_gender === 'all' ? 'Tous genres' : campaign.target_gender === 'male' ? 'Hommes' : 'Femmes'}
                      </span>
                      {campaign.target_interests?.slice(0, 3).map((int: string) => (
                        <span key={int} className="px-2 py-0.5 rounded-md bg-primary/10 text-primary">{int}</span>
                      ))}
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1"><Eye className="w-3.5 h-3.5" />{campaign.impressions}</span>
                      <span className="flex items-center gap-1"><MousePointerClick className="w-3.5 h-3.5" />{campaign.clicks}</span>
                      <span className="flex items-center gap-1"><DollarSign className="w-3.5 h-3.5" />{campaign.budget}€</span>
                      <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{format(new Date(campaign.ends_at), 'dd MMM', { locale: fr })}</span>
                    </div>
                    {campaign.status === 'active' && (
                      <div className="mt-3">
                        <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                          <motion.div initial={{ width: 0 }} animate={{ width: `${Math.min(((Date.now() - new Date(campaign.starts_at).getTime()) / (new Date(campaign.ends_at).getTime() - new Date(campaign.starts_at).getTime())) * 100, 100)}%` }}
                            className="h-full rounded-full bg-gradient-to-r from-primary to-primary/60" />
                        </div>
                      </div>
                    )}
                  </motion.div>
                ))
              )}
            </motion.div>
          )}

          {/* ====== PRICING TAB ====== */}
          {tab === 'pricing' && (
            <motion.div key="pricing" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-4">
              <div className="text-center mb-6">
                <Crown className="w-8 h-8 text-amber-500 mx-auto mb-2" />
                <h2 className="text-xl font-bold text-foreground">Tarifs ForSure Ads</h2>
                <p className="text-sm text-muted-foreground">Choisissez la durée idéale</p>
              </div>
              <div className="grid gap-4">
                {(Object.entries(PRICING) as [DurationType, typeof PRICING[DurationType]][]).map(([key, plan], i) => (
                  <motion.div key={key} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.08 }}
                    className={cn("p-5 rounded-2xl border bg-card flex items-center justify-between",
                      key === '1_month' ? 'border-primary/40 bg-primary/5 shadow-[0_4px_20px_hsl(var(--primary)/0.15)]' : 'border-border/30'
                    )}>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-foreground">{plan.label}</h3>
                        {key === '1_month' && <span className="px-2 py-0.5 rounded-md bg-primary text-primary-foreground text-[9px] font-bold">BEST</span>}
                      </div>
                      <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                        <Target className="w-3 h-3" />Portée: {plan.reach}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-black text-primary">{plan.price}€</p>
                      <Button size="sm" variant="outline" className="mt-2 rounded-xl text-xs" onClick={() => setTab('create')}>Choisir</Button>
                    </div>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </AppLayout>
  );
}
