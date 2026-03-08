import { Crown, BarChart3, Heart, TrendingUp, Sparkles, ExternalLink, RefreshCw, CreditCard, Lock, Users, Eye, UserCheck, Calendar, CheckCircle2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { AppLayout } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { useStripeSubscription } from '@/hooks/useStripeSubscription';
import { useIsCreatorRevenueEnabled, useCreatorEligibility, CREATOR_THRESHOLDS } from '@/hooks/usePlatformStats';
import { toast } from 'sonner';
import { useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

const BENEFITS = [
  { icon: Crown, title: 'Badge Créateur 👑', description: 'Un badge distinctif sur votre profil et vos publications' },
  { icon: BarChart3, title: 'Statistiques avancées', description: "Analytics détaillées sur la portée et l'engagement de votre contenu" },
  { icon: Heart, title: 'Monétisation', description: 'Recevez des tips et dons de vos abonnés' },
  { icon: TrendingUp, title: 'Priorité dans le feed', description: "Vos publications sont mises en avant dans l'algorithme" },
];

function formatCount(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return n.toString();
}

function ThresholdRow({ icon: Icon, label, current, target, met }: {
  icon: React.ElementType; label: string; current: number; target: number; met: boolean;
}) {
  const pct = Math.min(100, (current / target) * 100);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className="w-3.5 h-3.5" />
          {label}
        </span>
        <span className={cn('font-semibold', met ? 'text-green-500' : 'text-foreground')}>
          {formatCount(current)} / {formatCount(target)}
          {met && <CheckCircle2 className="w-3.5 h-3.5 inline ml-1 text-green-500" />}
        </span>
      </div>
      <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
        <motion.div
          className={cn('h-full rounded-full', met ? 'bg-green-500' : 'bg-gradient-to-r from-amber-500 to-orange-500')}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 1, delay: 0.3, ease: 'easeOut' }}
        />
      </div>
    </div>
  );
}

export default function CreatorUpgrade() {
  const { user } = useAuth();
  const { isCreatorSubscriber, subscriptionEnd, loading, startCheckout, openPortal, checkSubscription } = useStripeSubscription();
  const { enabled: revenueEnabled, userCount, threshold, loading: statsLoading } = useIsCreatorRevenueEnabled();
  const eligibility = useCreatorEligibility();
  const [searchParams] = useSearchParams();
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  useEffect(() => {
    if (searchParams.get('success') === 'true') {
      toast.success('🎉 Paiement réussi ! Votre abonnement Créateur est actif.');
      checkSubscription();
    } else if (searchParams.get('canceled') === 'true') {
      toast.info('Paiement annulé.');
    }
  }, [searchParams, checkSubscription]);

  const handleCheckout = async () => {
    if (!user) { toast.error('Vous devez être connecté'); return; }
    setCheckoutLoading(true);
    try { await startCheckout(); }
    catch (err: any) { toast.error(err.message || 'Erreur lors du paiement'); }
    finally { setCheckoutLoading(false); }
  };

  const handleManage = async () => {
    try { await openPortal(); }
    catch (err: any) { toast.error(err.message || 'Erreur'); }
  };

  return (
    <AppLayout>
      <div className="max-w-lg mx-auto space-y-6">
        {/* Hero */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="text-center space-y-3 pt-4">
          <div className="w-20 h-20 mx-auto rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-lg shadow-amber-500/25">
            <Crown className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-2xl font-bold">Devenir Créateur</h1>
          <p className="text-muted-foreground text-sm max-w-xs mx-auto">
            Démarquez-vous et accédez à des outils exclusifs pour développer votre audience
          </p>
        </motion.div>

        {/* Price card */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
          className={cn('rounded-2xl p-6 text-center border', isCreatorSubscriber
            ? 'bg-gradient-to-br from-green-500/10 to-emerald-500/10 border-green-500/30'
            : 'bg-gradient-to-br from-amber-500/10 to-orange-500/10 border-amber-500/20'
          )}
        >
          {isCreatorSubscriber ? (
            <>
              <div className="flex items-center justify-center gap-2 text-green-600 font-semibold mb-1">
                <Sparkles className="w-5 h-5" /> Abonnement actif
              </div>
              {subscriptionEnd && (
                <p className="text-xs text-muted-foreground">
                  Prochain renouvellement : {new Date(subscriptionEnd).toLocaleDateString('fr-FR', { dateStyle: 'long' })}
                </p>
              )}
            </>
          ) : (
            <>
              <div className="flex items-baseline justify-center gap-1">
                <span className="text-4xl font-bold">5€</span>
                <span className="text-muted-foreground">/mois</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Annulable à tout moment</p>
            </>
          )}
        </motion.div>

        {/* Benefits */}
        <div className="space-y-3">
          {BENEFITS.map((benefit, i) => (
            <motion.div key={benefit.title} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.15 + i * 0.05 }}
              className="flex items-start gap-3 p-4 bg-card rounded-xl border border-border"
            >
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400/20 to-orange-500/20 flex items-center justify-center shrink-0">
                <benefit.icon className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <h3 className="font-semibold text-sm">{benefit.title}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{benefit.description}</p>
              </div>
            </motion.div>
          ))}
        </div>

        {/* ── Seuils individuels créateur (style TikTok) ── */}
        {user && !eligibility.loading && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
            className={cn('rounded-2xl p-5 border space-y-4',
              eligibility.eligible
                ? 'border-green-500/30 bg-gradient-to-br from-green-500/5 to-emerald-500/5'
                : 'border-amber-500/20 bg-gradient-to-br from-amber-500/5 to-orange-500/5'
            )}
          >
            <div className="flex items-center gap-3">
              <div className={cn('w-10 h-10 rounded-full flex items-center justify-center',
                eligibility.eligible ? 'bg-green-500/10' : 'bg-amber-500/10'
              )}>
                {eligibility.eligible
                  ? <CheckCircle2 className="w-5 h-5 text-green-500" />
                  : <Lock className="w-5 h-5 text-amber-500" />}
              </div>
              <div>
                <h3 className="font-semibold text-sm">
                  {eligibility.eligible ? 'Éligible aux revenus ! 🎉' : 'Conditions de monétisation'}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {eligibility.eligible
                    ? 'Vous remplissez tous les critères'
                    : 'Atteignez ces seuils pour débloquer les revenus'}
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <ThresholdRow
                icon={Users}
                label="Abonnés"
                current={eligibility.followers}
                target={CREATOR_THRESHOLDS.followers}
                met={eligibility.meetFollowers}
              />
              <ThresholdRow
                icon={Eye}
                label="Vues lives (30j)"
                current={eligibility.liveViews30d}
                target={CREATOR_THRESHOLDS.liveViews30d}
                met={eligibility.meetLiveViews}
              />
              <ThresholdRow
                icon={UserCheck}
                label="Abonnés payants"
                current={eligibility.subscribers}
                target={CREATOR_THRESHOLDS.subscribers}
                met={eligibility.meetSubscribers}
              />
              <ThresholdRow
                icon={Calendar}
                label="Ancienneté (jours)"
                current={eligibility.accountAgeDays}
                target={CREATOR_THRESHOLDS.minAgeDays}
                met={eligibility.meetAccountAge}
              />
            </div>

            {!eligibility.eligible && (
              <p className="text-[10px] text-muted-foreground text-center pt-1">
                Continuez à créer du contenu et à faire grandir votre communauté 🚀
              </p>
            )}
          </motion.div>
        )}

        {/* Revenue unlock banner (seuil plateforme) */}
        {!revenueEnabled && !statsLoading && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}
            className="rounded-2xl p-5 border border-amber-500/20 bg-gradient-to-br from-amber-500/5 to-orange-500/5"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center">
                <Lock className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <h3 className="font-semibold text-sm">Seuil plateforme</h3>
                <p className="text-xs text-muted-foreground">Revenus débloqués à 100 000 inscrits</p>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" />{formatCount(userCount)} inscrits</span>
                <span>{formatCount(threshold)} requis</span>
              </div>
              <div className="w-full h-2.5 rounded-full bg-muted overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-amber-500 to-orange-500"
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(100, (userCount / threshold) * 100)}%` }}
                  transition={{ duration: 1, delay: 0.5, ease: 'easeOut' }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground text-center">
                Les tips et la monétisation seront activés une fois ce palier atteint 🚀
              </p>
            </div>
          </motion.div>
        )}

        {/* CTA */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} className="pt-2 pb-8 space-y-3">
          {loading ? (
            <div className="flex justify-center">
              <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : isCreatorSubscriber ? (
            <>
              <Button variant="outline" className="w-full" onClick={handleManage}>
                <CreditCard className="w-4 h-4 mr-2" /> Gérer mon abonnement <ExternalLink className="w-3 h-3 ml-2" />
              </Button>
              <Button variant="ghost" size="sm" className="w-full" onClick={() => checkSubscription()}>
                <RefreshCw className="w-3 h-3 mr-2" /> Actualiser le statut
              </Button>
            </>
          ) : (
            <>
              <Button
                className="w-full h-12 text-base font-semibold bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white border-0 rounded-xl shadow-lg shadow-amber-500/25"
                onClick={handleCheckout} disabled={checkoutLoading}
              >
                {checkoutLoading ? (
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <><Crown className="w-5 h-5 mr-2" /> Devenir Créateur — 5€/mois</>
                )}
              </Button>
              <p className="text-[10px] text-muted-foreground text-center">
                Paiement sécurisé via Stripe. Annulable à tout moment.
              </p>
            </>
          )}
        </motion.div>
      </div>
    </AppLayout>
  );
}
