import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AppLayout } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { 
  Megaphone, Plus, Sparkles, Loader2, TrendingUp, Eye, MousePointerClick, 
  DollarSign, Calendar, Target, Zap, BarChart3, CheckCircle2, ArrowRight,
  Users, Clock, Crown
} from 'lucide-react';
import { useAdCampaigns, useCreateAdCampaign, useAdAIAssistant, getAdPricing, DurationType } from '@/hooks/useAdCampaigns';
import { cn } from '@/lib/utils';
import { useImageUpload } from '@/hooks/useImageUpload';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

const PRICING = getAdPricing();

export default function AdsManager() {
  const { data: campaigns, isLoading } = useAdCampaigns();
  const createCampaign = useCreateAdCampaign();
  const aiAssistant = useAdAIAssistant();
  const { upload, isUploading } = useImageUpload({ bucket: 'post-images' });

  const [showCreate, setShowCreate] = useState(false);
  const [tab, setTab] = useState<'campaigns' | 'create' | 'stats'>('campaigns');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [ctaText, setCtaText] = useState('En savoir plus');
  const [ctaUrl, setCtaUrl] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [duration, setDuration] = useState<DurationType>('1_week');
  const [targetAudience, setTargetAudience] = useState('');

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
      duration_type: duration,
    });
    setTitle('');
    setBody('');
    setCtaText('En savoir plus');
    setCtaUrl('');
    setImageUrl('');
    setTab('campaigns');
  };

  const totalImpressions = campaigns?.reduce((s, c) => s + c.impressions, 0) || 0;
  const totalClicks = campaigns?.reduce((s, c) => s + c.clicks, 0) || 0;
  const totalSpent = campaigns?.reduce((s, c) => s + c.spent, 0) || 0;
  const activeCampaigns = campaigns?.filter(c => c.status === 'active') || [];

  return (
    <AppLayout>
      <div className="max-w-4xl mx-auto px-4 pb-24">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative py-8 text-center"
        >
          <div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent rounded-3xl" />
          <div className="relative">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-2xl bg-primary/10 border border-primary/20 mb-4">
              <Megaphone className="w-5 h-5 text-primary" />
              <span className="text-sm font-semibold text-primary">ForSure Ads</span>
            </div>
            <h1 className="text-3xl font-bold text-foreground mb-2">Gestionnaire de Publicités</h1>
            <p className="text-muted-foreground text-sm max-w-md mx-auto">
              Créez des campagnes publicitaires propulsées par l'IA et atteignez votre audience idéale
            </p>
          </div>
        </motion.div>

        {/* Stats Overview */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6"
        >
          {[
            { icon: BarChart3, label: 'Campagnes actives', value: activeCampaigns.length, color: 'text-emerald-500' },
            { icon: Eye, label: 'Impressions', value: totalImpressions.toLocaleString(), color: 'text-blue-500' },
            { icon: MousePointerClick, label: 'Clics', value: totalClicks.toLocaleString(), color: 'text-purple-500' },
            { icon: DollarSign, label: 'Dépensé', value: `${totalSpent}€`, color: 'text-amber-500' },
          ].map((stat, i) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.15 + i * 0.05 }}
              className="p-4 rounded-2xl bg-card border border-border/30 text-center"
            >
              <stat.icon className={cn("w-5 h-5 mx-auto mb-2", stat.color)} />
              <p className="text-xl font-bold text-foreground">{stat.value}</p>
              <p className="text-[11px] text-muted-foreground">{stat.label}</p>
            </motion.div>
          ))}
        </motion.div>

        {/* Tabs */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-1">
          {[
            { id: 'campaigns' as const, label: 'Mes Campagnes', icon: BarChart3 },
            { id: 'create' as const, label: 'Créer une Pub', icon: Plus },
            { id: 'stats' as const, label: 'Tarifs', icon: Crown },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all whitespace-nowrap",
                tab === t.id
                  ? "bg-primary text-primary-foreground shadow-[0_4px_12px_hsl(var(--primary)/0.3)]"
                  : "bg-secondary/50 text-muted-foreground hover:bg-secondary"
              )}
            >
              <t.icon className="w-4 h-4" />
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <AnimatePresence mode="wait">
          {tab === 'create' && (
            <motion.div
              key="create"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-6"
            >
              {/* AI Assistant */}
              <div className="p-5 rounded-2xl bg-gradient-to-br from-primary/5 via-card to-accent/5 border border-primary/20">
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles className="w-5 h-5 text-primary" />
                  <h3 className="font-semibold text-foreground">Assistant IA</h3>
                </div>
                <p className="text-xs text-muted-foreground mb-3">
                  Décrivez votre produit/service et laissez l'IA créer votre publicité
                </p>
                <Button
                  onClick={handleAIGenerate}
                  disabled={aiAssistant.isPending}
                  className="w-full rounded-xl gap-2 premium-button"
                >
                  {aiAssistant.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Zap className="w-4 h-4" />
                  )}
                  Générer avec l'IA
                </Button>
              </div>

              {/* Form */}
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Titre de la pub</label>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Ex: Découvrez notre nouvelle collection"
                    className="rounded-xl"
                  />
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Texte publicitaire</label>
                  <Textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="Décrivez votre offre de manière engageante..."
                    className="rounded-xl min-h-[100px]"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1.5 block">Bouton CTA</label>
                    <Input
                      value={ctaText}
                      onChange={(e) => setCtaText(e.target.value)}
                      placeholder="En savoir plus"
                      className="rounded-xl"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1.5 block">Lien CTA</label>
                    <Input
                      value={ctaUrl}
                      onChange={(e) => setCtaUrl(e.target.value)}
                      placeholder="https://..."
                      className="rounded-xl"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Audience cible</label>
                  <Input
                    value={targetAudience}
                    onChange={(e) => setTargetAudience(e.target.value)}
                    placeholder="Ex: Jeunes 18-35 ans, passionnés de mode"
                    className="rounded-xl"
                  />
                </div>

                {/* Image */}
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Image publicitaire</label>
                  {imageUrl ? (
                    <div className="relative rounded-xl overflow-hidden">
                      <img src={imageUrl} alt="Ad" className="w-full h-48 object-cover" />
                      <button
                        onClick={() => setImageUrl('')}
                        className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/50 text-white text-xs"
                      >
                        Supprimer
                      </button>
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

                {/* Duration Selection */}
                <div>
                  <label className="text-sm font-medium text-foreground mb-3 block flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-primary" />
                    Durée de la campagne
                  </label>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {(Object.entries(PRICING) as [DurationType, typeof PRICING[DurationType]][]).map(([key, plan]) => (
                      <motion.button
                        key={key}
                        whileHover={{ scale: 1.02, y: -2 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => setDuration(key)}
                        className={cn(
                          "relative p-4 rounded-2xl border-2 text-left transition-all",
                          duration === key
                            ? "border-primary bg-primary/5 shadow-[0_4px_16px_hsl(var(--primary)/0.2)]"
                            : "border-border/30 bg-card hover:border-primary/30"
                        )}
                      >
                        {key === '1_month' && (
                          <span className="absolute -top-2 -right-2 px-2 py-0.5 rounded-lg bg-amber-500 text-white text-[9px] font-bold">
                            POPULAIRE
                          </span>
                        )}
                        <p className="font-bold text-foreground text-sm">{plan.label}</p>
                        <p className="text-2xl font-black text-primary mt-1">{plan.price}€</p>
                        <div className="flex items-center gap-1 mt-2 text-[11px] text-muted-foreground">
                          <Users className="w-3 h-3" />
                          <span>{plan.reach} portée</span>
                        </div>
                        {duration === key && (
                          <motion.div
                            layoutId="selected-plan"
                            className="absolute top-2 right-2"
                          >
                            <CheckCircle2 className="w-5 h-5 text-primary" />
                          </motion.div>
                        )}
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
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20">
                          <Megaphone className="w-3 h-3 text-amber-500" />
                          <span className="text-[10px] font-semibold text-amber-600 uppercase tracking-wider">Sponsorisé</span>
                        </div>
                      </div>
                      <div className="px-4 pb-3">
                        <h3 className="font-bold text-base">{title || 'Titre de votre pub'}</h3>
                        <p className="text-sm text-muted-foreground mt-1">{body || 'Votre texte publicitaire apparaîtra ici...'}</p>
                      </div>
                      {imageUrl && <img src={imageUrl} alt="Preview" className="w-full h-48 object-cover" />}
                      <div className="px-4 py-3 border-t border-border/20">
                        <Button className="w-full rounded-xl gap-2" size="sm">
                          <ArrowRight className="w-4 h-4" />
                          {ctaText}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Submit */}
                <Button
                  onClick={handleCreate}
                  disabled={!title.trim() || !body.trim() || createCampaign.isPending}
                  className="w-full h-12 rounded-xl text-base font-semibold gap-2 bg-gradient-to-r from-primary to-primary/80 shadow-[0_4px_16px_hsl(var(--primary)/0.3)]"
                >
                  {createCampaign.isPending ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <Megaphone className="w-5 h-5" />
                  )}
                  Lancer la campagne — {PRICING[duration].price}€
                </Button>
              </div>
            </motion.div>
          )}

          {tab === 'campaigns' && (
            <motion.div
              key="campaigns"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-4"
            >
              {isLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="h-32 rounded-2xl skeleton" />
                  ))}
                </div>
              ) : !campaigns?.length ? (
                <div className="text-center py-16">
                  <Megaphone className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
                  <h3 className="font-semibold text-foreground mb-2">Aucune campagne</h3>
                  <p className="text-sm text-muted-foreground mb-4">Créez votre première publicité et touchez des milliers de personnes</p>
                  <Button onClick={() => setTab('create')} className="rounded-xl gap-2 premium-button">
                    <Plus className="w-4 h-4" />
                    Créer une campagne
                  </Button>
                </div>
              ) : (
                campaigns.map((campaign, i) => (
                  <motion.div
                    key={campaign.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="p-4 rounded-2xl bg-card border border-border/30"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-foreground truncate">{campaign.title}</h3>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{campaign.body}</p>
                      </div>
                      <span className={cn(
                        "px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase",
                        campaign.status === 'active' ? 'bg-emerald-500/15 text-emerald-600' :
                        campaign.status === 'draft' ? 'bg-amber-500/15 text-amber-600' :
                        'bg-muted text-muted-foreground'
                      )}>
                        {campaign.status === 'active' ? 'Active' : campaign.status === 'draft' ? 'Brouillon' : 'Terminée'}
                      </span>
                    </div>

                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1"><Eye className="w-3.5 h-3.5" />{campaign.impressions}</span>
                      <span className="flex items-center gap-1"><MousePointerClick className="w-3.5 h-3.5" />{campaign.clicks}</span>
                      <span className="flex items-center gap-1"><DollarSign className="w-3.5 h-3.5" />{campaign.budget}€</span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" />
                        {format(new Date(campaign.ends_at), 'dd MMM', { locale: fr })}
                      </span>
                    </div>

                    {/* Progress bar */}
                    {campaign.status === 'active' && (
                      <div className="mt-3">
                        <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{
                              width: `${Math.min(
                                ((Date.now() - new Date(campaign.starts_at).getTime()) /
                                  (new Date(campaign.ends_at).getTime() - new Date(campaign.starts_at).getTime())) * 100,
                                100
                              )}%`
                            }}
                            className="h-full rounded-full bg-gradient-to-r from-primary to-primary/60"
                          />
                        </div>
                      </div>
                    )}
                  </motion.div>
                ))
              )}
            </motion.div>
          )}

          {tab === 'stats' && (
            <motion.div
              key="stats"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-4"
            >
              <div className="text-center mb-6">
                <Crown className="w-8 h-8 text-amber-500 mx-auto mb-2" />
                <h2 className="text-xl font-bold text-foreground">Tarifs ForSure Ads</h2>
                <p className="text-sm text-muted-foreground">Choisissez la durée idéale pour votre campagne</p>
              </div>

              <div className="grid gap-4">
                {(Object.entries(PRICING) as [DurationType, typeof PRICING[DurationType]][]).map(([key, plan], i) => (
                  <motion.div
                    key={key}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.08 }}
                    className={cn(
                      "p-5 rounded-2xl border bg-card flex items-center justify-between",
                      key === '1_month' ? 'border-primary/40 bg-primary/5 shadow-[0_4px_20px_hsl(var(--primary)/0.15)]' : 'border-border/30'
                    )}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-foreground">{plan.label}</h3>
                        {key === '1_month' && (
                          <span className="px-2 py-0.5 rounded-md bg-primary text-primary-foreground text-[9px] font-bold">BEST</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                        <Target className="w-3 h-3" />
                        Portée estimée: {plan.reach}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-black text-primary">{plan.price}€</p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2 rounded-xl text-xs"
                        onClick={() => { setDuration(key); setTab('create'); }}
                      >
                        Choisir
                      </Button>
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
