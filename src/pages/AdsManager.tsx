/**
 * Espace Pub — Meta-style Ads Manager.
 *
 * Hierarchy: Campaign (objective) → Ad Set (audience/budget/placements) → Ad (creative + KPI).
 * Layout inspired by Meta Ads Manager: KPI strip on top, 3 tabs (Campagnes / Ensembles / Publicités),
 * drill-down navigation, and a 4-step create wizard with a final review.
 */
import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AppLayout } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Megaphone, Plus, Sparkles, Eye, MousePointerClick, TrendingUp, DollarSign,
  Target, Layers, Image as ImageIcon, ArrowRight, ArrowLeft, Check, Play, Pause,
  Users, Calendar, MapPin, Zap, X, Loader2, Trash2, CreditCard, ShieldCheck,
  Smartphone, Monitor, CircleAlert,
} from 'lucide-react';
import {
  useAdCampaigns, useCreateAdCampaign, useDeleteAdCampaign, useStartAdCheckout, type AdCampaign,
} from '@/hooks/useAdCampaigns';
import {
  useAdSets, useAds, useCreateAdSet, useCreateAd, useUpdateAdSet, useUpdateAd, useDeleteAd,
  OBJECTIVES, PLACEMENTS, type Ad, type AdSet,
} from '@/hooks/useAdsMeta';
import { LocationSelector } from '@/components/ads/LocationSelector';
import { getDefaultLocation, type TargetLocation } from '@/lib/geoData';
import { useImageUpload } from '@/hooks/useImageUpload';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { toast } from 'sonner';
import {
  DELIVERABLE_AD_PLACEMENTS,
  evaluateAdDraft,
  getAdHealth,
  hasRequiredAdQuality,
  type AdHealth,
} from '@/lib/ads/adDelivery';

import { AD_INTERESTS as INTERESTS } from '@/lib/discovery';
const DEFAULT_AD_PLACEMENTS = [...DELIVERABLE_AD_PLACEMENTS];

type Level = 'campaigns' | 'adsets' | 'ads';
type CampaignView = 'all' | 'old';

function dateHasPassed(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function isOldCampaign(campaign: AdCampaign): boolean {
  return campaign.status !== 'active' || dateHasPassed(campaign.ends_at);
}

function isOldAd(ad: Ad, adSet?: AdSet): boolean {
  return ad.status !== 'active' || (adSet ? dateHasPassed(adSet.ends_at) : false);
}

export default function AdsManager() {
  const { data: campaigns = [], isLoading: loadingCampaigns, refetch: refetchCampaigns } = useAdCampaigns();
  const { data: allAdSets = [] } = useAdSets();
  const { data: allAds = [] } = useAds();

  const [level, setLevel] = useState<Level>('campaigns');
  const [selectedCampaign, setSelectedCampaign] = useState<string | null>(null);
  const [selectedAdSet, setSelectedAdSet] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [campaignView, setCampaignView] = useState<CampaignView>('all');

  // Aggregate KPIs (across all ads)
  const kpis = useMemo(() => {
    const totals = allAds.reduce(
      (acc, a) => ({
        impressions: acc.impressions + (a.impressions || 0),
        reach: acc.reach + (a.reach || 0),
        clicks: acc.clicks + (a.clicks || 0),
        spent: acc.spent + Number(a.spent || 0),
      }),
      { impressions: 0, reach: 0, clicks: 0, spent: 0 },
    );
    const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
    const cpc = totals.clicks > 0 ? totals.spent / totals.clicks : 0;
    return { ...totals, ctr, cpc };
  }, [allAds]);

  const filteredAdSets = selectedCampaign ? allAdSets.filter(s => s.campaign_id === selectedCampaign) : allAdSets;
  const filteredAds = selectedAdSet ? allAds.filter(a => a.ad_set_id === selectedAdSet) : allAds;
  const oldCampaignCount = campaigns.filter(isOldCampaign).length;
  const visibleCampaigns = campaignView === 'old' ? campaigns.filter(isOldCampaign) : campaigns;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get('payment');
    if (!payment) return;

    if (payment === 'success') {
      toast.success('Paiement reçu. Activation de la campagne en cours.');
      void refetchCampaigns();
      const retry = window.setTimeout(() => void refetchCampaigns(), 1500);
      window.history.replaceState({}, document.title, window.location.pathname);
      return () => window.clearTimeout(retry);
    }

    if (payment === 'canceled') {
      toast.info('Paiement annulé. La campagne reste en attente et peut être reprise.');
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [refetchCampaigns]);

  return (
    <AppLayout>
      <div className="max-w-6xl mx-auto pb-24">
        {/* Header */}
        <header className="px-4 pt-3 pb-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Megaphone className="w-5 h-5 text-primary" />
              Espace Pub
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">Campagnes · Ensembles · Publicités</p>
          </div>
          <Button onClick={() => setShowWizard(true)} size="sm" className="gap-1.5 rounded-full">
            <Plus className="w-4 h-4" /> Créer
          </Button>
        </header>

        {/* KPI strip */}
        <section className="px-4 grid grid-cols-2 md:grid-cols-6 gap-2 mb-3">
          <KpiCard icon={<Eye className="w-3.5 h-3.5" />} label="Impressions" value={fmt(kpis.impressions)} tint="blue" />
          <KpiCard icon={<Users className="w-3.5 h-3.5" />} label="Portée" value={fmt(kpis.reach)} tint="violet" />
          <KpiCard icon={<MousePointerClick className="w-3.5 h-3.5" />} label="Clics" value={fmt(kpis.clicks)} tint="emerald" />
          <KpiCard icon={<TrendingUp className="w-3.5 h-3.5" />} label="CTR" value={`${kpis.ctr.toFixed(2)}%`} tint="amber" />
          <KpiCard icon={<Target className="w-3.5 h-3.5" />} label="CPC" value={kpis.clicks > 0 ? `${kpis.cpc.toFixed(2)}€` : '—'} tint="blue" />
          <KpiCard icon={<DollarSign className="w-3.5 h-3.5" />} label="Dépensé" value={`${kpis.spent.toFixed(2)}€`} tint="rose" />
        </section>

        <PerformanceOverview impressions={kpis.impressions} clicks={kpis.clicks} ctr={kpis.ctr} />

        {/* Breadcrumb */}
        {(selectedCampaign || selectedAdSet) && (
          <div className="px-4 mb-2 flex items-center gap-2 text-xs">
            <button onClick={() => { setSelectedCampaign(null); setSelectedAdSet(null); setLevel('campaigns'); }} className="text-primary hover:underline">Toutes campagnes</button>
            {selectedCampaign && (
              <>
                <ArrowRight className="w-3 h-3 text-muted-foreground" />
                <button onClick={() => { setSelectedAdSet(null); setLevel('adsets'); }} className="text-primary hover:underline">
                  {campaigns.find(c => c.id === selectedCampaign)?.title || 'Campagne'}
                </button>
              </>
            )}
            {selectedAdSet && (
              <>
                <ArrowRight className="w-3 h-3 text-muted-foreground" />
                <span>{allAdSets.find(s => s.id === selectedAdSet)?.name}</span>
              </>
            )}
          </div>
        )}

        {/* Tabs */}
        <Tabs value={level} onValueChange={(v) => setLevel(v as Level)} className="px-4">
          <TabsList className="grid grid-cols-3 w-full rounded-full h-10 bg-secondary/40">
            <TabsTrigger value="campaigns" className="rounded-full text-xs gap-1.5">
              <Target className="w-3.5 h-3.5" /> Campagnes ({campaigns.length})
            </TabsTrigger>
            <TabsTrigger value="adsets" className="rounded-full text-xs gap-1.5">
              <Layers className="w-3.5 h-3.5" /> Ensembles ({filteredAdSets.length})
            </TabsTrigger>
            <TabsTrigger value="ads" className="rounded-full text-xs gap-1.5">
              <ImageIcon className="w-3.5 h-3.5" /> Publicités ({filteredAds.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="campaigns" className="mt-4 space-y-2">
            {campaigns.length > 0 && (
              <div className="flex items-center justify-between gap-2 pb-1">
                <p className="text-[11px] text-muted-foreground">
                  Les suppressions sont définitives et limitées à vos campagnes terminées ou inactives.
                </p>
                <div className="flex items-center rounded-full bg-secondary/50 p-0.5 shrink-0">
                  <Button
                    type="button"
                    size="sm"
                    variant={campaignView === 'all' ? 'default' : 'ghost'}
                    className="h-7 rounded-full px-3 text-[11px]"
                    onClick={() => setCampaignView('all')}
                  >
                    Toutes
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={campaignView === 'old' ? 'default' : 'ghost'}
                    className="h-7 rounded-full px-3 text-[11px]"
                    onClick={() => setCampaignView('old')}
                  >
                    Anciennes ({oldCampaignCount})
                  </Button>
                </div>
              </div>
            )}
            {loadingCampaigns ? (
              <SkeletonRow />
            ) : campaigns.length === 0 ? (
              <EmptyState onCreate={() => setShowWizard(true)} />
            ) : visibleCampaigns.length === 0 ? (
              <div className="premium-card p-8 text-center text-sm text-muted-foreground">
                Aucune ancienne campagne à supprimer.
              </div>
            ) : (
              visibleCampaigns.map(c => {
                const sets = allAdSets.filter(s => s.campaign_id === c.id);
                const ads = allAds.filter(a => sets.some(s => s.id === a.ad_set_id));
                const impressions = ads.reduce((n, a) => n + (a.impressions || 0), 0);
                const clicks = ads.reduce((n, a) => n + (a.clicks || 0), 0);
                const spent = ads.reduce((n, a) => n + Number(a.spent || 0), 0);
                const obj = OBJECTIVES.find(o => o.value === c.objective) ?? OBJECTIVES[1];
                const health = getAdHealth({
                  campaignStatus: c.status,
                  campaignModerationStatus: c.moderation_status,
                  adCount: ads.length,
                  activeAdCount: ads.filter(ad => ad.status === 'active' && ad.moderation_status === 'approved').length,
                  impressions,
                  clicks,
                });
                return (
                  <div key={c.id} className="w-full premium-card p-3 flex items-center gap-2 hover:border-primary/40 transition-all">
                    <button
                      type="button"
                      onClick={() => { setSelectedCampaign(c.id); setLevel('adsets'); }}
                      className="flex-1 min-w-0 text-left flex items-center gap-3"
                    >
                      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-lg flex-shrink-0">{obj.icon}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold truncate">{c.title}</span>
                          <StatusPill status={c.status} />
                          <HealthPill health={health} />
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {obj.label} · {sets.length} ensemble{sets.length > 1 ? 's' : ''} · {ads.length} pub{ads.length > 1 ? 's' : ''} · fin {format(new Date(c.ends_at), 'dd MMM yyyy', { locale: fr })}
                        </p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-sm font-bold tabular-nums">{fmt(impressions)}</p>
                        <p className="text-[10px] text-muted-foreground">{spent.toFixed(2)}€ dépensés</p>
                      </div>
                    </button>
                    {c.status === 'pending_payment' && <ResumeCheckoutButton campaign={c} />}
                    {isOldCampaign(c) && <DeleteCampaignButton campaign={c} />}
                  </div>
                );
              })
            )}
          </TabsContent>

          <TabsContent value="adsets" className="mt-4 space-y-2">
            {filteredAdSets.length === 0 ? (
              <EmptyState label="Aucun ensemble" onCreate={() => setShowWizard(true)} />
            ) : (
              filteredAdSets.map(s => (
                <AdSetRow
                  key={s.id}
                  set={s}
                  ads={allAds.filter(a => a.ad_set_id === s.id)}
                  onOpen={() => { setSelectedAdSet(s.id); setLevel('ads'); }}
                />
              ))
            )}
          </TabsContent>

          <TabsContent value="ads" className="mt-4 space-y-2">
            {filteredAds.length === 0 ? (
              <EmptyState label="Aucune publicité" onCreate={() => setShowWizard(true)} />
            ) : (
              filteredAds.map(a => (
                <AdRow key={a.id} ad={a} adSet={allAdSets.find(set => set.id === a.ad_set_id)} />
              ))
            )}
          </TabsContent>
        </Tabs>
      </div>

      <CreateWizard open={showWizard} onClose={() => setShowWizard(false)} />
    </AppLayout>
  );
}

// ── UI atoms ──

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const TINTS = {
  blue: 'from-blue-500/10 to-blue-500/5 text-blue-400',
  violet: 'from-violet-500/10 to-violet-500/5 text-violet-400',
  emerald: 'from-emerald-500/10 to-emerald-500/5 text-emerald-400',
  amber: 'from-amber-500/10 to-amber-500/5 text-amber-400',
  rose: 'from-rose-500/10 to-rose-500/5 text-rose-400',
} as const;

function KpiCard({ icon, label, value, tint }: { icon: React.ReactNode; label: string; value: string; tint: keyof typeof TINTS }) {
  return (
    <div className={cn('rounded-2xl border border-border/20 bg-gradient-to-br p-2.5', TINTS[tint])}>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider opacity-80">
        {icon}
        <span>{label}</span>
      </div>
      <p className="text-lg font-bold tabular-nums mt-0.5 text-foreground">{value}</p>
    </div>
  );
}

function PerformanceOverview({ impressions, clicks, ctr }: { impressions: number; clicks: number; ctr: number }) {
  const hasData = impressions > 0;

  return (
    <section className="mx-4 mb-4 premium-card px-3 py-2.5 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <TrendingUp className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold">Parcours de diffusion</p>
          <p className="text-[10px] text-muted-foreground">
            {hasData ? 'Impressions et clics uniques dédupliqués.' : 'Les indicateurs apparaîtront après les premières diffusions.'}
          </p>
        </div>
      </div>
      <div className="flex-1 flex items-center gap-2 text-[11px] sm:justify-end">
        <span className="rounded-full bg-blue-500/10 text-blue-500 px-2.5 py-1">{fmt(impressions)} vues</span>
        <ArrowRight className="w-3 h-3 text-muted-foreground" />
        <span className="rounded-full bg-emerald-500/10 text-emerald-500 px-2.5 py-1">{fmt(clicks)} clics</span>
        <span className="rounded-full bg-amber-500/10 text-amber-500 px-2.5 py-1">{ctr.toFixed(2)}% CTR</span>
      </div>
    </section>
  );
}

const HEALTH_TONES: Record<AdHealth['tone'], string> = {
  healthy: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  learning: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  warning: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  blocked: 'bg-destructive/10 text-destructive border-destructive/20',
  neutral: 'bg-muted text-muted-foreground border-border',
};

function HealthPill({ health }: { health: AdHealth }) {
  return (
    <span
      title={health.detail}
      className={cn('hidden sm:inline-flex text-[9px] px-1.5 py-0.5 rounded-full border font-semibold', HEALTH_TONES[health.tone])}
    >
      {health.label}
    </span>
  );
}

function ReviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/40 bg-secondary/20 p-2.5 min-w-0">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-xs font-medium truncate mt-0.5" title={value}>{value}</p>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
    paused: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
    draft: 'bg-muted text-muted-foreground border-border',
    ended: 'bg-muted text-muted-foreground border-border',
    rejected: 'bg-destructive/10 text-destructive border-destructive/20',
    pending_payment: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  };
  const label: Record<string, string> = { active: 'En cours', paused: 'En pause', draft: 'Brouillon', ended: 'Terminé', rejected: 'Rejeté', pending_payment: 'Paiement requis' };
  return (
    <span className={cn('text-[9px] px-1.5 py-0.5 rounded-full border font-semibold uppercase tracking-wider', styles[status] || styles.draft)}>
      {label[status] || status}
    </span>
  );
}

function SkeletonRow() {
  return <div className="premium-card p-3 h-16 animate-pulse" />;
}

function EmptyState({ label = 'Aucune campagne', onCreate }: { label?: string; onCreate: () => void }) {
  return (
    <div className="premium-card p-10 text-center">
      <Megaphone className="w-10 h-10 text-muted-foreground/30 mx-auto mb-2" />
      <p className="text-sm text-muted-foreground">{label}</p>
      <Button size="sm" onClick={onCreate} className="mt-3 gap-1.5 rounded-full">
        <Plus className="w-3.5 h-3.5" /> Créer une campagne
      </Button>
    </div>
  );
}

function AdSetRow({ set, ads, onOpen }: { set: AdSet; ads: Ad[]; onOpen: () => void }) {
  const update = useUpdateAdSet();
  const impressions = ads.reduce((n, a) => n + a.impressions, 0);
  const isActive = set.status === 'active';
  const hasEnded = set.status === 'ended' || dateHasPassed(set.ends_at);
  return (
    <div className="premium-card p-3 flex items-center gap-3">
      <button onClick={onOpen} className="flex-1 text-left min-w-0 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center flex-shrink-0">
          <Layers className="w-4 h-4 text-violet-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold truncate">{set.name}</span>
            <StatusPill status={set.status} />
          </div>
          <p className="text-[11px] text-muted-foreground truncate">
            {set.target_age_min}-{set.target_age_max} ans · {set.placements.length} placement{set.placements.length > 1 ? 's' : ''} · {ads.length} pub{ads.length > 1 ? 's' : ''}
          </p>
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-sm font-bold tabular-nums">{fmt(impressions)}</p>
          <p className="text-[10px] text-muted-foreground">impressions</p>
        </div>
      </button>
      <Switch
        checked={isActive}
        disabled={hasEnded || update.isPending}
        onCheckedChange={(v) => update.mutate({ id: set.id, patch: { status: v ? 'active' : 'paused' } })}
        aria-label="Activer / mettre en pause"
      />
    </div>
  );
}

function AdRow({ ad, adSet }: { ad: Ad; adSet?: AdSet }) {
  const update = useUpdateAd();
  const ctr = ad.impressions > 0 ? (ad.clicks / ad.impressions) * 100 : 0;
  const hasEnded = ad.status === 'ended' || ad.status === 'rejected' || (adSet ? dateHasPassed(adSet.ends_at) : false);
  return (
    <div className="premium-card p-3 flex items-center gap-3">
      <div className="w-14 h-14 rounded-xl overflow-hidden bg-secondary/40 flex-shrink-0">
        {ad.image_url ? (
          <img src={ad.image_url} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground">
            <ImageIcon className="w-5 h-5" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold truncate">{ad.headline}</span>
          <StatusPill status={ad.status} />
        </div>
        <p className="text-[11px] text-muted-foreground line-clamp-1">{ad.primary_text}</p>
        <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
          <span>{fmt(ad.impressions)} imp.</span>
          <span>{fmt(ad.clicks)} clics</span>
          <span>{ctr.toFixed(2)}% CTR</span>
          <span>{Number(ad.spent).toFixed(2)}€</span>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <Button
          variant="ghost"
          size="icon"
          disabled={hasEnded || update.isPending}
          aria-label={ad.status === 'active' ? 'Mettre la publicité en pause' : 'Activer la publicité'}
          onClick={() => update.mutate({ id: ad.id, patch: { status: ad.status === 'active' ? 'paused' : 'active' } })}
          className="rounded-full"
        >
          {ad.status === 'active' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </Button>
        {isOldAd(ad, adSet) && <DeleteAdButton ad={ad} />}
      </div>
    </div>
  );
}

function DeleteCampaignButton({ campaign }: { campaign: AdCampaign }) {
  const removeCampaign = useDeleteAdCampaign();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="rounded-full text-destructive" aria-label={`Supprimer ${campaign.title}`}>
          <Trash2 className="w-4 h-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Supprimer cette ancienne campagne ?</AlertDialogTitle>
          <AlertDialogDescription>
            « {campaign.title} », ses ensembles, ses publicités et ses statistiques seront supprimés définitivement.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Annuler</AlertDialogCancel>
          <AlertDialogAction
            disabled={removeCampaign.isPending}
            onClick={() => removeCampaign.mutate(campaign.id)}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Supprimer
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ResumeCheckoutButton({ campaign }: { campaign: AdCampaign }) {
  const checkout = useStartAdCheckout();

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={checkout.isPending}
      onClick={() => checkout.mutate(campaign.id)}
      className="rounded-full text-primary"
      aria-label={`Payer la campagne ${campaign.title}`}
      title="Reprendre le paiement"
    >
      {checkout.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
    </Button>
  );
}

function DeleteAdButton({ ad }: { ad: Ad }) {
  const removeAd = useDeleteAd();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="rounded-full text-destructive" aria-label={`Supprimer ${ad.headline}`}>
          <Trash2 className="w-4 h-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Supprimer cette ancienne publicité ?</AlertDialogTitle>
          <AlertDialogDescription>
            « {ad.headline} » sera supprimée définitivement. La campagne parente restera disponible.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Annuler</AlertDialogCancel>
          <AlertDialogAction
            disabled={removeAd.isPending}
            onClick={() => removeAd.mutate(ad.id)}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Supprimer
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Create Wizard ──

function CreateWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState(1);
  // Step 1 – Campaign
  const [objective, setObjective] = useState<string>('traffic');
  const [campaignName, setCampaignName] = useState('');
  // Step 2 – Ad set
  const [ageRange, setAgeRange] = useState<[number, number]>([18, 65]);
  const [gender, setGender] = useState<'all' | 'male' | 'female'>('all');
  const [interests, setInterests] = useState<string[]>([]);
  const [location, setLocation] = useState<TargetLocation>(getDefaultLocation());
  const [budget, setBudget] = useState(25);
  const [days, setDays] = useState(7);
  const [placementMode, setPlacementMode] = useState<'automatic' | 'manual'>('automatic');
  const [placements, setPlacements] = useState<string[]>(DEFAULT_AD_PLACEMENTS);
  const [optimizationGoal, setOptimizationGoal] = useState<'reach' | 'impressions' | 'clicks' | 'conversions' | 'engagement'>('reach');
  // Step 3 – Ad
  const [headline, setHeadline] = useState('');
  const [primaryText, setPrimaryText] = useState('');
  const [ctaText, setCtaText] = useState('En savoir plus');
  const [ctaUrl, setCtaUrl] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [previewDevice, setPreviewDevice] = useState<'mobile' | 'desktop'>('mobile');

  const { upload } = useImageUpload({ bucket: 'uploads' });
  const createCampaign = useCreateAdCampaign();
  const createAdSet = useCreateAdSet();
  const createAd = useCreateAd();
  const startCheckout = useStartAdCheckout();

  const reset = () => {
    setStep(1);
    setObjective('traffic');
    setCampaignName('');
    setAgeRange([18, 65]);
    setGender('all');
    setInterests([]);
    setLocation(getDefaultLocation());
    setBudget(25);
    setDays(7);
    setPlacementMode('automatic');
    setPlacements(DEFAULT_AD_PLACEMENTS);
    setOptimizationGoal('reach');
    setHeadline('');
    setPrimaryText('');
    setCtaText('En savoir plus');
    setCtaUrl('');
    setImageUrl('');
    setPreviewDevice('mobile');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleImage = async (file: File) => {
    setUploading(true);
    try {
      const url = await upload(file);
      if (url) setImageUrl(url);
    } finally {
      setUploading(false);
    }
  };

  const qualityChecks = useMemo(() => evaluateAdDraft({
    headline,
    primaryText,
    ctaUrl,
    imageUrl,
    placements,
  }), [ctaUrl, headline, imageUrl, placements, primaryText]);
  const requiredQualityReady = hasRequiredAdQuality(qualityChecks);
  const dailyBudget = Number.isFinite(budget) && Number.isFinite(days) && days > 0 ? budget / days : 0;

  const canNext =
    (step === 1 && !!objective && campaignName.trim().length >= 3) ||
    (step === 2 && Number.isFinite(budget) && budget >= 5 && Number.isInteger(days) && days >= 1 && days <= 90 && placements.length > 0) ||
    (step === 3 && requiredQualityReady) ||
    step === 4;

  const handleSubmit = async () => {
    try {
      if (!requiredQualityReady) throw new Error('Corrige les contrôles obligatoires avant le paiement');

      // 1. Campaign
      const campaign = await createCampaign.mutateAsync({
        title: campaignName,
        body: primaryText,
        objective,
        image_url: imageUrl || undefined,
        cta_text: ctaText,
        cta_url: ctaUrl.trim() || undefined,
        target_age_min: ageRange[0],
        target_age_max: ageRange[1],
        target_gender: gender,
        target_interests: interests,
        target_location: {
          country: location.country,
          region: location.region,
          villes: location.villes,
        },
        budget,
        duration_days: days,
      });

      // 2. Ad Set
      const now = new Date();
      const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      const adSet = await createAdSet.mutateAsync({
        campaign_id: campaign.id,
        name: `${campaignName} – Ensemble 1`,
        status: 'draft',
        lifetime_budget: budget,
        starts_at: now.toISOString(),
        ends_at: end.toISOString(),
        target_age_min: ageRange[0],
        target_age_max: ageRange[1],
        target_gender: gender,
        target_interests: interests,
        target_location: {
          country: location.country,
          region: location.region,
          villes: location.villes,
        },
        placements,
        optimization_goal: optimizationGoal,
      });

      // 3. Ad
      await createAd.mutateAsync({
        ad_set_id: adSet.id,
        name: headline,
        status: 'draft',
        headline,
        primary_text: primaryText,
        image_url: imageUrl || null,
        cta_text: ctaText,
        cta_url: ctaUrl || null,
        moderation_status: 'approved',
      });

      toast.success('Campagne prête. Ouverture du paiement sécurisé...');
      await startCheckout.mutateAsync(campaign.id);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Erreur lors de la création');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            Nouvelle campagne
          </DialogTitle>
        </DialogHeader>

        {/* Stepper */}
        <div className="flex items-center gap-2 mb-4">
          {[1, 2, 3, 4].map(n => (
            <div key={n} className="flex-1 flex items-center gap-2">
              <div className={cn(
                'w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0',
                step >= n ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
              )}>
                {step > n ? <Check className="w-3 h-3" /> : n}
              </div>
              <span className={cn('text-[11px] font-medium', step >= n ? 'text-foreground' : 'text-muted-foreground')}>
                {n === 1 ? 'Objectif' : n === 2 ? 'Audience' : n === 3 ? 'Créatif' : 'Vérification'}
              </span>
              {n < 4 && <div className={cn('flex-1 h-px', step > n ? 'bg-primary' : 'bg-border')} />}
            </div>
          ))}
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            transition={{ duration: 0.18 }}
            className="space-y-4"
          >
            {step === 1 && (
              <>
                <div>
                  <label className="text-xs font-semibold mb-2 block">Objectif de la campagne</label>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {OBJECTIVES.map(o => (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => setObjective(o.value)}
                        className={cn(
                          'text-left p-3 rounded-2xl border-2 transition-all',
                          objective === o.value ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40',
                        )}
                      >
                        <div className="text-xl mb-1">{o.icon}</div>
                        <p className="text-xs font-semibold">{o.label}</p>
                        <p className="text-[10px] text-muted-foreground line-clamp-2">{o.desc}</p>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-semibold mb-1 block">Nom de la campagne</label>
                  <Input
                    value={campaignName}
                    onChange={e => setCampaignName(e.target.value)}
                    placeholder="Ex. Lancement collection été"
                  />
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <div>
                  <label className="text-xs font-semibold mb-1 block flex items-center justify-between">
                    <span className="flex items-center gap-1"><Users className="w-3 h-3" /> Âge</span>
                    <span className="text-muted-foreground tabular-nums">{ageRange[0]} – {ageRange[1]} ans</span>
                  </label>
                  <Slider min={18} max={65} step={1} value={ageRange} onValueChange={(v) => setAgeRange([v[0], v[1]] as [number, number])} />
                  <p className="text-xs text-muted-foreground mt-2">65 signifie 65 ans et plus. Sans restriction : diffusion générale aux adultes. Les intérêts, tranches d’âge précises et zones locales exigent le consentement du destinataire.</p>
                </div>
                <div>
                  <label className="text-xs font-semibold mb-1 block">Genre</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['all'] as const).map(g => (
                      <button
                        key={g}
                        type="button"
                        onClick={() => setGender(g)}
                        className={cn(
                          'py-2 rounded-xl text-xs font-medium border transition-all',
                          gender === g ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:border-primary/40',
                        )}
                      >
                        Tous
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-semibold mb-1 block flex items-center gap-1"><MapPin className="w-3 h-3" /> Localisation</label>
                  <LocationSelector value={location} onChange={setLocation} />
                </div>
                <div>
                  <label className="text-xs font-semibold mb-1 block">Centres d'intérêt</label>
                  <div className="flex flex-wrap gap-1.5">
                    {INTERESTS.map(i => {
                      const on = interests.includes(i);
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setInterests(prev => on ? prev.filter(x => x !== i) : [...prev, i])}
                          className={cn(
                            'text-[11px] px-2.5 py-1 rounded-full border transition-all',
                            on ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:border-primary/40',
                          )}
                        >
                          {i}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-semibold mb-1 block flex items-center gap-1"><DollarSign className="w-3 h-3" /> Budget total</label>
                    <div className="flex items-center gap-2">
                      <Input type="number" min={5} value={budget} onChange={e => setBudget(Number(e.target.value))} />
                      <span className="text-xs text-muted-foreground">€</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-semibold mb-1 block flex items-center gap-1"><Calendar className="w-3 h-3" /> Durée</label>
                    <div className="flex items-center gap-2">
                      <Input type="number" min={1} max={90} value={days} onChange={e => setDays(Number(e.target.value))} />
                      <span className="text-xs text-muted-foreground">jours</span>
                    </div>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-semibold mb-1 block flex items-center gap-1"><Zap className="w-3 h-3" /> Optimisation</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['reach', 'clicks', 'engagement'] as const).map(g => (
                      <button
                        key={g}
                        type="button"
                        onClick={() => setOptimizationGoal(g)}
                        className={cn(
                          'py-2 rounded-xl text-xs font-medium border transition-all',
                          optimizationGoal === g ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:border-primary/40',
                        )}
                      >
                        {g === 'reach' ? 'Portée' : g === 'clicks' ? 'Clics' : 'Engagement'}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-semibold mb-1 block">Mode de placement</label>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <button
                      type="button"
                      onClick={() => {
                        setPlacementMode('automatic');
                        setPlacements(DEFAULT_AD_PLACEMENTS);
                      }}
                      className={cn(
                        'text-left p-2.5 rounded-xl border transition-all',
                        placementMode === 'automatic' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40',
                      )}
                    >
                      <span className="text-xs font-semibold flex items-center gap-1"><Sparkles className="w-3 h-3" /> Automatique</span>
                      <span className="text-[10px] text-muted-foreground">Recommandé · seulement les surfaces réellement actives</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPlacementMode('manual')}
                      className={cn(
                        'text-left p-2.5 rounded-xl border transition-all',
                        placementMode === 'manual' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40',
                      )}
                    >
                      <span className="text-xs font-semibold">Manuel</span>
                      <span className="block text-[10px] text-muted-foreground">Choisir chaque surface disponible</span>
                    </button>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {PLACEMENTS.map(p => {
                      const on = placements.includes(p.value);
                      return (
                        <button
                          key={p.value}
                          type="button"
                          disabled={!p.available || placementMode === 'automatic'}
                          onClick={() => setPlacements(prev => on ? prev.filter(x => x !== p.value) : [...prev, p.value])}
                          className={cn(
                            'text-left px-2.5 py-2 rounded-xl border transition-all disabled:cursor-not-allowed',
                            on ? 'bg-primary/10 text-primary border-primary' : 'border-border hover:border-primary/40',
                            !p.available && 'opacity-50 bg-muted/30',
                          )}
                        >
                          <span className="text-xs font-medium block">{p.label}</span>
                          <span className="text-[9px] text-muted-foreground">{p.available ? p.description : `${p.description} · bientôt`}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-2 flex items-start gap-1">
                    <ShieldCheck className="w-3 h-3 mt-0.5 shrink-0 text-primary" />
                    Le paiement ne couvre que les emplacements activés. Stories, Reels et autres surfaces resteront indisponibles tant que leur diffusion n’est pas câblée.
                  </p>
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <div>
                  <label className="text-xs font-semibold mb-1 block">Titre</label>
                  <Input value={headline} onChange={e => setHeadline(e.target.value)} maxLength={60} placeholder="Ex. Découvre la nouvelle collection" />
                </div>
                <div>
                  <label className="text-xs font-semibold mb-1 block">Texte principal</label>
                  <Textarea value={primaryText} onChange={e => setPrimaryText(e.target.value)} maxLength={280} rows={4} placeholder="Décris ton offre en quelques mots percutants" />
                  <p className="text-[10px] text-muted-foreground text-right mt-1">{primaryText.length}/280</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-semibold mb-1 block">Bouton (CTA)</label>
                    <Input value={ctaText} onChange={e => setCtaText(e.target.value)} maxLength={20} />
                  </div>
                  <div>
                    <label className="text-xs font-semibold mb-1 block">URL de destination</label>
                    <Input
                      value={ctaUrl}
                      onChange={e => setCtaUrl(e.target.value)}
                      placeholder="https://…"
                      aria-invalid={!qualityChecks.find(check => check.id === 'destination')?.passed}
                    />
                    {!qualityChecks.find(check => check.id === 'destination')?.passed && (
                      <p className="text-[10px] text-destructive mt-1">Utilise une adresse complète commençant par https:// ou http://.</p>
                    )}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-semibold mb-1 block">Image (recommandée)</label>
                  <div className="flex items-center gap-2">
                    <input id="ad-img" type="file" accept="image/*" onChange={e => e.target.files?.[0] && handleImage(e.target.files[0])} className="hidden" />
                    <label htmlFor="ad-img" className="flex-1 flex items-center gap-2 px-3 py-2 rounded-xl border border-border cursor-pointer hover:border-primary/40 text-xs">
                      {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
                      {imageUrl ? 'Changer l\'image' : 'Ajouter une image'}
                    </label>
                    {imageUrl && <img src={imageUrl} alt="" className="w-12 h-12 rounded-lg object-cover" />}
                  </div>
                </div>

                {/* Preview */}
                <div className="mt-2">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Aperçu du fil</p>
                    <div className="flex rounded-full bg-secondary/50 p-0.5">
                      <Button
                        type="button"
                        size="icon"
                        variant={previewDevice === 'mobile' ? 'default' : 'ghost'}
                        className="w-7 h-7 rounded-full"
                        onClick={() => setPreviewDevice('mobile')}
                        aria-label="Aperçu mobile"
                      >
                        <Smartphone className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant={previewDevice === 'desktop' ? 'default' : 'ghost'}
                        className="w-7 h-7 rounded-full"
                        onClick={() => setPreviewDevice('desktop')}
                        aria-label="Aperçu ordinateur"
                      >
                        <Monitor className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                  <div className={cn('premium-card p-3 mx-auto transition-all', previewDevice === 'mobile' ? 'max-w-[360px]' : 'max-w-full')}>
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-bold text-primary">Ad</div>
                      <div>
                        <p className="text-xs font-semibold">Ta marque · <span className="text-muted-foreground font-normal">Sponsorisé</span></p>
                      </div>
                    </div>
                    {imageUrl && <img src={imageUrl} alt="" className={cn('w-full object-cover rounded-xl mb-2', previewDevice === 'mobile' ? 'aspect-[4/5]' : 'aspect-video')} />}
                    <p className="text-sm font-semibold mb-0.5">{headline || 'Ton titre ici'}</p>
                    <p className="text-xs text-muted-foreground line-clamp-2 mb-2">{primaryText || 'Ton texte principal apparaîtra ici.'}</p>
                    {ctaUrl.trim() && <Button type="button" size="sm" className="w-full rounded-full text-xs">{ctaText}</Button>}
                  </div>
                </div>

                <div className="rounded-2xl border border-border/50 p-3">
                  <p className="text-xs font-semibold mb-2 flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-primary" /> Contrôle qualité</p>
                  <div className="grid sm:grid-cols-2 gap-1.5">
                    {qualityChecks.map(check => (
                      <div key={check.id} className="flex items-start gap-1.5 text-[10px]">
                        {check.passed ? <Check className="w-3 h-3 text-emerald-500 mt-0.5 shrink-0" /> : <CircleAlert className={cn('w-3 h-3 mt-0.5 shrink-0', check.required ? 'text-destructive' : 'text-amber-500')} />}
                        <span className={check.passed ? 'text-muted-foreground' : check.required ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'}>
                          {check.label}{!check.required && ' (conseillé)'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {step === 4 && (
              <>
                <div className="rounded-2xl border border-primary/20 bg-primary/5 p-3 flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs font-semibold">Vérification avant paiement</p>
                    <p className="text-[10px] text-muted-foreground">La campagne restera inactive tant que le paiement et la modération serveur ne sont pas confirmés.</p>
                  </div>
                </div>

                <div className="grid sm:grid-cols-2 gap-2">
                  <ReviewItem label="Campagne" value={campaignName} />
                  <ReviewItem label="Objectif" value={OBJECTIVES.find(item => item.value === objective)?.label || objective} />
                  <ReviewItem label="Audience" value={`${ageRange[0]}–${ageRange[1]} ans · ${interests.length ? `${interests.length} intérêt(s)` : 'large'}`} />
                  <ReviewItem label="Zone" value={`${location.country}${location.region ? ` · ${location.region}` : ''}`} />
                  <ReviewItem label="Budget" value={`${budget.toFixed(2)} € · ${dailyBudget.toFixed(2)} €/jour · ${days} jours`} />
                  <ReviewItem label="Placement" value={placements.map(value => PLACEMENTS.find(item => item.value === value)?.label || value).join(', ')} />
                </div>

                <div className="premium-card p-3">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Créatif</p>
                  <div className="flex gap-3">
                    {imageUrl ? (
                      <img src={imageUrl} alt="" className="w-20 h-20 rounded-xl object-cover shrink-0" />
                    ) : (
                      <div className="w-20 h-20 rounded-xl bg-secondary/40 flex items-center justify-center shrink-0"><ImageIcon className="w-5 h-5 text-muted-foreground" /></div>
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{headline}</p>
                      <p className="text-xs text-muted-foreground line-clamp-3">{primaryText}</p>
                      {ctaUrl.trim() && <p className="text-[10px] text-primary truncate mt-1">{ctaText} · {ctaUrl}</p>}
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-border/50 p-3">
                  <p className="text-xs font-semibold mb-2">Résultat des contrôles</p>
                  {qualityChecks.map(check => (
                    <div key={check.id} className="flex items-center gap-2 text-[11px] py-0.5">
                      {check.passed ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <CircleAlert className="w-3.5 h-3.5 text-amber-500" />}
                      <span className="text-muted-foreground">{check.label}{!check.required && ' (conseillé)'}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </motion.div>
        </AnimatePresence>

        <div className="flex items-center justify-between gap-2 pt-2 border-t border-border/40">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => (step === 1 ? handleClose() : setStep(step - 1))}
            className="gap-1 rounded-full"
          >
            {step === 1 ? <><X className="w-3.5 h-3.5" /> Annuler</> : <><ArrowLeft className="w-3.5 h-3.5" /> Retour</>}
          </Button>
          {step < 4 ? (
            <Button size="sm" disabled={!canNext} onClick={() => setStep(step + 1)} className="gap-1 rounded-full">
              Suivant <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!canNext || createCampaign.isPending || createAdSet.isPending || createAd.isPending || startCheckout.isPending}
              onClick={handleSubmit}
              className="gap-1 rounded-full"
            >
              {(createCampaign.isPending || createAdSet.isPending || createAd.isPending || startCheckout.isPending) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Passer au paiement sécurisé
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
