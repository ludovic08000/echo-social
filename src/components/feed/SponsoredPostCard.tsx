import { motion } from 'framer-motion';
import { Megaphone, ExternalLink, Eye, MousePointerClick } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AdCampaign } from '@/hooks/useAdCampaigns';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { useEffect, useRef } from 'react';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

interface SponsoredPostCardProps {
  ad: AdCampaign;
}

export function SponsoredPostCard({ ad }: SponsoredPostCardProps) {
  const { user } = useAuth();
  const tracked = useRef(false);

  // Track impression
  useEffect(() => {
    if (tracked.current || !user) return;
    tracked.current = true;
    supabase.from('ad_interactions').insert({
      campaign_id: ad.id,
      user_id: user.id,
      interaction_type: 'impression',
    }).then(() => {});
  }, [ad.id, user]);

  const handleClick = async () => {
    if (user) {
      await supabase.from('ad_interactions').insert({
        campaign_id: ad.id,
        user_id: user.id,
        interaction_type: 'click',
      });
    }
    if (ad.cta_url) window.open(ad.cta_url, '_blank');
  };

  return (
    <motion.article
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      className="relative bg-card border border-border/20 rounded-2xl overflow-hidden"
    >
      {/* Sponsored badge */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <Megaphone className="w-3 h-3 text-amber-500" />
          <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider">
            Sponsorisé
          </span>
        </div>
      </div>

      {/* Ad content */}
      <div className="px-4 pb-3">
        <h3 className="font-bold text-base text-foreground mb-1">{ad.title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">{ad.body}</p>
      </div>

      {ad.image_url && (
        <div className="relative w-full overflow-hidden">
          <img
            src={ad.image_url}
            alt={ad.title}
            className="w-full object-cover max-h-[400px]"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent" />
        </div>
      )}

      {/* CTA */}
      <div className="px-4 py-3 border-t border-border/20">
        <Button
          onClick={handleClick}
          className="w-full rounded-xl gap-2 bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 shadow-[0_4px_12px_hsl(var(--primary)/0.3)]"
        >
          <ExternalLink className="w-4 h-4" />
          {ad.cta_text || 'En savoir plus'}
        </Button>
      </div>

      {/* Stats for advertiser */}
      {ad.advertiser_id === user?.id && (
        <div className="px-4 pb-3 flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><Eye className="w-3 h-3" />{ad.impressions} vues</span>
          <span className="flex items-center gap-1"><MousePointerClick className="w-3 h-3" />{ad.clicks} clics</span>
        </div>
      )}
    </motion.article>
  );
}
