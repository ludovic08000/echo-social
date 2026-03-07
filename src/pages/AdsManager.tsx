import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AppLayout } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import { 
  Megaphone, Plus, Sparkles, Loader2, Eye, MousePointerClick, 
  DollarSign, Calendar, Target, Zap, BarChart3, CheckCircle2, ArrowRight,
  Users, Clock, Crown, Shield, ShieldCheck, ShieldX, TrendingUp,
  UserCheck
} from 'lucide-react';
import { useAdCampaigns, useCreateAdCampaign, useAdAIAssistant, useAdDailyStats, getAdPricing, DurationType, AdCampaign } from '@/hooks/useAdCampaigns';
import { cn } from '@/lib/utils';
import { useImageUpload } from '@/hooks/useImageUpload';
import { format, subDays, eachDayOfInterval } from 'date-fns';
import { fr } from 'date-fns/locale';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell } from 'recharts';

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

// Generate mock chart data based on campaigns
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

export default function AdsManager() {
  const { data: campaigns, isLoading } = useAdCampaigns();
  const createCampaign = useCreateAdCampaign();
  const aiAssistant = useAdAIAssistant();
  const { upload, isUploading } = useImageUpload({ bucket: 'post-images' });

  const [tab, setTab] = useState<'campaigns' | 'create' | 'analytics' | 'pricing'>('campaigns');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [ctaText, setCtaText] = useState('En savoir plus');
  const [ctaUrl, setCtaUrl] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [duration, setDuration] = useState<DurationType>('1_week');
  const [targetAudience, setTargetAudience] = useState('');
  const [ageRange, setAgeRange] = useState([18, 45]);
  const [gender, setGender] = useState('all');
  const [interests, setInterests] = useState<string[]>([]);
  const [moderationResult, setModerationResult] = useState<any>(null);
  const [moderating, setModerating] = useState(false);

  const chartData = generateChartData(campaigns || []);

  const handleAIGenerate = async () => {
    const result = await aiAssistant.mutateAsync({
      action: 'generate_ad',
      product_name: title || 'Mon produit',
      product_description: body,
      target_audience: targetAudience,
      duration: PRICING[duration].label,
      budget: PRICING[duration].price,
    });
    if (result) {
      if (result.title) setTitle(result.title);
      if (result.body) setBody(result.body);
      if (result.cta_text) setCtaText(result.cta_text);
    }
  };

  const handleModerate = async () => {
    setModerating(true);
    try {
      const result = await aiAssistant.mutateAsync({
        action: 'moderate_ad',
        ad_title: title,
        ad_body: body,
        target_audience: targetAudience,
      });
      setModerationResult(result);
    } finally {
      setModerating(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = await upload(file);
    if (url) setImageUrl(url);
  };

  const handleCreate = async () => {
    if (!title.trim() || !body.trim()) return;
    await createCampaign.mutateAsync({
      title,
      body,
      image_url: imageUrl || undefined,
      cta_text: ctaText,
      cta_url: ctaUrl || undefined,
      target_audience: targetAudience ? { description: targetAudience } : undefined,
      target_age_min: ageRange[0],
      target_age_max: ageRange[1],
      target_gender: gender,
      target_interests: interests,
      duration_type: duration,
    });
    setTitle(''); setBody(''); setCtaText('En savoir plus'); setCtaUrl('');
    setImageUrl(''); setModerationResult(null); setInterests([]);
    setTab('campaigns');
  };

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
              Campagnes publicitaires propulsées par l'IA avec modération automatique
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
            { id: 'create' as const, label: 'Créer', icon: Plus },
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
              
              {/* Impressions & Clicks Chart */}
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

              {/* Spending Chart */}
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

              {/* Pie Chart */}
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
                            {pieData.map((entry, i) => (
                              <Cell key={i} fill={entry.color} />
                            ))}
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

          {/* ====== CREATE TAB ====== */}
          {tab === 'create' && (
            <motion.div key="create" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-6">
              {/* AI Assistant */}
              <div className="p-5 rounded-2xl bg-gradient-to-br from-primary/5 via-card to-accent/5 border border-primary/20">
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles className="w-5 h-5 text-primary" />
                  <h3 className="font-semibold text-foreground">Assistant IA</h3>
                </div>
                <p className="text-xs text-muted-foreground mb-3">Décrivez votre produit et laissez l'IA créer votre publicité</p>
                <div className="flex gap-2">
                  <Button onClick={handleAIGenerate} disabled={aiAssistant.isPending} className="flex-1 rounded-xl gap-2 premium-button">
                    {aiAssistant.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                    Générer
                  </Button>
                  <Button onClick={handleModerate} disabled={moderating || !title || !body} variant="outline" className="rounded-xl gap-2">
                    {moderating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
                    Vérifier
                  </Button>
                </div>
              </div>

              {/* Moderation Result */}
              <AnimatePresence>
                {moderationResult && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                    className={cn("p-4 rounded-2xl border", moderationResult.approved !== false
                      ? "bg-emerald-500/5 border-emerald-500/20" : "bg-destructive/5 border-destructive/20"
                    )}>
                    <div className="flex items-center gap-2 mb-2">
                      {moderationResult.approved !== false ? (
                        <><ShieldCheck className="w-5 h-5 text-emerald-500" /><span className="font-semibold text-emerald-600 text-sm">Approuvé — Score: {moderationResult.score}/10</span></>
                      ) : (
                        <><ShieldX className="w-5 h-5 text-destructive" /><span className="font-semibold text-destructive text-sm">Refusé</span></>
                      )}
                    </div>
                    {moderationResult.reasons?.length > 0 && (
                      <ul className="space-y-1 ml-7">{moderationResult.reasons.map((r: string, i: number) => (
                        <li key={i} className="text-xs text-muted-foreground">• {r}</li>
                      ))}</ul>
                    )}
                    {moderationResult.suggestions?.length > 0 && (
                      <div className="mt-2 ml-7">
                        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Suggestions</p>
                        {moderationResult.suggestions.map((s: string, i: number) => (
                          <p key={i} className="text-xs text-primary">💡 {s}</p>
                        ))}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Form */}
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Titre de la pub</label>
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex: Découvrez notre nouvelle collection" className="rounded-xl" />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Texte publicitaire</label>
                  <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Décrivez votre offre..." className="rounded-xl min-h-[100px]" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1.5 block">Bouton CTA</label>
                    <Input value={ctaText} onChange={(e) => setCtaText(e.target.value)} placeholder="En savoir plus" className="rounded-xl" />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1.5 block">Lien CTA</label>
                    <Input value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} placeholder="https://..." className="rounded-xl" />
                  </div>
                </div>

                {/* Age Targeting */}
                <div className="p-4 rounded-2xl bg-secondary/20 border border-border/30 space-y-4">
                  <div className="flex items-center gap-2">
                    <Target className="w-4 h-4 text-primary" />
                    <h4 className="font-semibold text-foreground text-sm">Ciblage avancé</h4>
                  </div>

                  {/* Age Range */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs font-medium text-muted-foreground">Tranche d'âge</label>
                      <span className="text-xs font-bold text-primary">{ageRange[0]} — {ageRange[1]} ans</span>
                    </div>
                    <Slider value={ageRange} onValueChange={setAgeRange} min={13} max={75} step={1} className="w-full" />
                    <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                      <span>13 ans</span><span>75 ans</span>
                    </div>
                  </div>

                  {/* Gender */}
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-2 block">Genre</label>
                    <div className="flex gap-2">
                      {GENDER_OPTIONS.map(g => (
                        <button key={g.value} onClick={() => setGender(g.value)}
                          className={cn("flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-medium transition-all border",
                            gender === g.value ? "bg-primary/10 text-primary border-primary/30" : "bg-card text-muted-foreground border-border/30 hover:border-primary/20"
                          )}>
                          <g.icon className="w-3.5 h-3.5" />{g.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Interests */}
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-2 block">Centres d'intérêt</label>
                    <div className="flex flex-wrap gap-2">
                      {INTEREST_OPTIONS.map(interest => (
                        <button key={interest} onClick={() => setInterests(prev => prev.includes(interest) ? prev.filter(i => i !== interest) : [...prev, interest])}
                          className={cn("px-3 py-1.5 rounded-xl text-xs font-medium transition-all border",
                            interests.includes(interest)
                              ? "bg-primary/10 text-primary border-primary/30"
                              : "bg-card text-muted-foreground border-border/30 hover:border-primary/20"
                          )}>
                          {interest}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Text audience */}
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Description audience (optionnel)</label>
                    <Input value={targetAudience} onChange={(e) => setTargetAudience(e.target.value)} placeholder="Ex: Entrepreneurs parisiens" className="rounded-xl text-sm" />
                  </div>
                </div>

                {/* Image */}
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Image publicitaire</label>
                  {imageUrl ? (
                    <div className="relative rounded-xl overflow-hidden">
                      <img src={imageUrl} alt="Ad" className="w-full h-48 object-cover" />
                      <button onClick={() => setImageUrl('')} className="absolute top-2 right-2 p-1.5 rounded-lg bg-background/80 backdrop-blur-sm text-foreground text-xs border border-border/30">Supprimer</button>
                    </div>
                  ) : (
                    <label className="flex items-center justify-center h-32 rounded-xl border-2 border-dashed border-border/50 cursor-pointer hover:border-primary/50 transition-colors">
                      <div className="text-center">
                        <Plus className="w-6 h-6 text-muted-foreground mx-auto mb-1" />
                        <span className="text-xs text-muted-foreground">Ajouter une image</span>
                      </div>
                      <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                    </label>
                  )}
                </div>

                {/* Duration */}
                <div>
                  <label className="text-sm font-medium text-foreground mb-3 flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-primary" /> Durée de la campagne
                  </label>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {(Object.entries(PRICING) as [DurationType, typeof PRICING[DurationType]][]).map(([key, plan]) => (
                      <motion.button key={key} whileHover={{ scale: 1.02, y: -2 }} whileTap={{ scale: 0.98 }} onClick={() => setDuration(key)}
                        className={cn("relative p-4 rounded-2xl border-2 text-left transition-all",
                          duration === key ? "border-primary bg-primary/5 shadow-[0_4px_16px_hsl(var(--primary)/0.2)]" : "border-border/30 bg-card hover:border-primary/30"
                        )}>
                        {key === '1_month' && <span className="absolute -top-2 -right-2 px-2 py-0.5 rounded-lg bg-primary text-primary-foreground text-[9px] font-bold">POPULAIRE</span>}
                        <p className="font-bold text-foreground text-sm">{plan.label}</p>
                        <p className="text-2xl font-black text-primary mt-1">{plan.price}€</p>
                        <div className="flex items-center gap-1 mt-2 text-[11px] text-muted-foreground">
                          <Users className="w-3 h-3" /><span>{plan.reach}</span>
                        </div>
                        {duration === key && <motion.div layoutId="selected-plan" className="absolute top-2 right-2"><CheckCircle2 className="w-5 h-5 text-primary" /></motion.div>}
                      </motion.button>
                    ))}
                  </div>
                </div>

                {/* Preview */}
                {(title || body) && (
                  <div>
                    <label className="text-sm font-medium text-foreground mb-3 block">Aperçu</label>
                    <div className="rounded-2xl border border-border/30 overflow-hidden bg-card">
                      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-primary/10 border border-primary/20">
                          <Megaphone className="w-3 h-3 text-primary" />
                          <span className="text-[10px] font-semibold text-primary uppercase tracking-wider">Sponsorisé</span>
                        </div>
                        <span className="text-[10px] text-muted-foreground">{ageRange[0]}-{ageRange[1]} ans • {gender === 'all' ? 'Tous' : gender === 'male' ? 'Hommes' : 'Femmes'}</span>
                      </div>
                      <div className="px-4 pb-3">
                        <h3 className="font-bold text-base">{title || 'Titre'}</h3>
                        <p className="text-sm text-muted-foreground mt-1">{body || '...'}</p>
                      </div>
                      {imageUrl && <img src={imageUrl} alt="Preview" className="w-full h-48 object-cover" />}
                      <div className="px-4 py-3 border-t border-border/20">
                        <Button className="w-full rounded-xl gap-2" size="sm"><ArrowRight className="w-4 h-4" />{ctaText}</Button>
                      </div>
                    </div>
                  </div>
                )}

                <Button onClick={handleCreate} disabled={!title.trim() || !body.trim() || createCampaign.isPending}
                  className="w-full h-12 rounded-xl text-base font-semibold gap-2 bg-gradient-to-r from-primary to-primary/80 shadow-[0_4px_16px_hsl(var(--primary)/0.3)]">
                  {createCampaign.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Megaphone className="w-5 h-5" />}
                  Lancer la campagne — {PRICING[duration].price}€
                </Button>
              </div>
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
                  <p className="text-sm text-muted-foreground mb-4">Créez votre première publicité</p>
                  <Button onClick={() => setTab('create')} className="rounded-xl gap-2 premium-button"><Plus className="w-4 h-4" />Créer</Button>
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

                    {/* Targeting info */}
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
                      <Button size="sm" variant="outline" className="mt-2 rounded-xl text-xs" onClick={() => { setDuration(key); setTab('create'); }}>Choisir</Button>
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
