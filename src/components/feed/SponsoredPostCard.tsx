import { motion } from 'framer-motion';
import { Megaphone, ExternalLink, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { type FeedAd } from '@/hooks/useAdCampaigns';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { useEffect, useRef } from 'react';
import { sanitizeUrl } from '@/lib/sanitizeUrl';
import { toast } from 'sonner';
import { type AdPlacement } from '@/lib/ads/adDelivery';
import { GeoAttribution } from '@/components/geo/GeoAttribution';

interface SponsoredPostCardProps {
  ad: FeedAd;
  placement?: AdPlacement;
}

export function SponsoredPostCard({ ad, placement = 'feed' }: SponsoredPostCardProps) {
  const { user } = useAuth();
  const tracked = useRef(false);
  const articleRef = useRef<HTMLElement | null>(null);
  const explain = async () => {
    try {
      const { data, error } = await supabase.rpc('get_my_ad_explanation' as never, { p_ad_id: ad.id } as never);
      if (error || !data) throw new Error('Unavailable');
      const explanation = data as unknown as { topics: string[]; local: boolean; advertiser: string; ageRange?: number[] | null;
        zone?: { country: string; region: string | null; city: string | null; source: string } | null };
      toast.info('Pourquoi cette publicité ?', {
        description: [explanation.advertiser && `Annonceur : ${explanation.advertiser}.`,
          explanation.topics?.length ? `Thèmes autorisés : ${explanation.topics.join(', ')}.` : (!explanation.local && !explanation.ageRange ? 'Diffusion générale.' : null),
          explanation.local && `Zone autorisée : ${[explanation.zone?.city, explanation.zone?.region, explanation.zone?.country].filter(Boolean).join(', ') || 'locale'} (${explanation.zone?.source === 'network' ? 'estimation réseau, peut être inexacte' : explanation.zone?.source === 'profile' ? 'ville du profil' : 'ton choix'}).`,
          explanation.ageRange && `Tranche d’âge choisie par l’annonceur : ${explanation.ageRange.join('–')}.`,
          'Choix modifiables dans Paramètres → Vie privée.'].filter(Boolean).join(' '),
      });
    } catch { toast.info('Explication momentanément indisponible. Tes choix restent modifiables dans Paramètres → Vie privée.'); }
  };

  // Count a view only after at least half the creative remains visible for one second.
  useEffect(() => {
    const element = articleRef.current;
    if (!element || !user?.id || tracked.current) return;

    let timer: number | null = null;
    const recordImpression = () => {
      if (tracked.current) return;
      tracked.current = true;
      void supabase.rpc(
        'track_ad_interaction' as never,
        { p_ad_id: ad.id, p_kind: 'impression', p_placement: placement } as never,
      );
    };

    if (!('IntersectionObserver' in window)) {
      recordImpression();
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && entry.intersectionRatio >= 0.5) {
        if (timer === null) timer = window.setTimeout(recordImpression, 1_000);
      } else if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    }, { threshold: [0.5] });

    observer.observe(element);
    return () => {
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [ad.id, placement, user?.id]);

  const handleClick = () => {
    if (user?.id) {
      void supabase.rpc(
        'track_ad_interaction' as never,
        { p_ad_id: ad.id, p_kind: 'click', p_placement: placement } as never,
      );
    }
    if (ad.cta_url) {
      const safe = sanitizeUrl(ad.cta_url);
      if (safe !== '#') window.open(safe, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <motion.article
      ref={articleRef}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      className="relative bg-card border border-border/20 rounded-2xl overflow-hidden"
    >
      {/* Sponsored badge */}
      <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <Megaphone className="w-3 h-3 text-amber-500" />
          <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider">
            Sponsorisé
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-full text-muted-foreground"
          aria-label="Pourquoi cette publicité ?"
          onClick={() => void explain()}
        >
          <Info className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Ad content */}
      <div className="px-4 pb-3">
        <GeoAttribution />
        <h3 className="font-bold text-base text-foreground mb-1">{ad.headline}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">{ad.primary_text}</p>
      </div>

      {ad.video_url ? (
        <div className="relative w-full overflow-hidden bg-black">
          <video
            src={ad.video_url}
            poster={ad.image_url || undefined}
            controls
            playsInline
            preload="metadata"
            className="w-full max-h-[520px] object-contain"
          />
        </div>
      ) : ad.image_url ? (
        <div className="relative w-full overflow-hidden">
          <img
            src={ad.image_url}
            alt={ad.headline}
            className="w-full object-cover max-h-[400px]"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent" />
        </div>
      ) : null}

      {/* CTA */}
      {ad.cta_url && <div className="px-4 py-3 border-t border-border/20">
        <Button
          type="button"
          onClick={handleClick}
          className="w-full rounded-xl gap-2 bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 shadow-[0_4px_12px_hsl(var(--primary)/0.3)]"
        >
          <ExternalLink className="w-4 h-4" />
          {ad.cta_text || 'En savoir plus'}
        </Button>
      </div>}
    </motion.article>
  );
}
