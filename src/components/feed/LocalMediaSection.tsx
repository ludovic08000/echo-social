import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router-dom';
import { MapPin, MessageCircle, Newspaper, Play } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { type MediaScope, type MediaKind, type PartnerMediaItem, partnerThumbnailUrl, safePartnerUrl, youtubeEmbedUrl } from '@/lib/discovery';
import { REACTION_EMOJIS, REACTION_LABELS, type ReactionType } from '@/hooks/useReactions';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { GeoAttribution } from '@/components/geo/GeoAttribution';
import { browserLocationContext, browserLocaleContext } from '@/lib/browserLocation';
const ShareNews = lazy(() => import('@/components/ShareButton').then(m => ({ default: m.ShareButton })));
const Discussion = lazy(() => import('./NewsDiscussionPanel').then(m => ({ default: m.NewsDiscussionPanel })));
type MediaContext = { country: string; region: string; city: string | null; source: string;
  display?: { country: string; region: string | null; city: string | null } };

const editorialCategoryLabel = {
  general: 'Actualité',
  science: 'Science',
  music: 'Musique',
  education: 'Éducation',
  wellbeing: 'Bien-être',
  sport: 'Sport',
} as const;

const rankReasonLabel: Record<string, string> = {
  declared_interest: 'Selon tes choix',
  local_relevance: 'Près de chez toi',
  positive_editorial_diversity: 'Découverte positive',
};

const REACTION_KEYS = Object.keys(REACTION_EMOJIS) as ReactionType[];

type NewsReactions = { counts: Partial<Record<ReactionType, number>>; mine: ReactionType | null };

/** Réactions emoji d'une carte d'actualité : une seule par membre, réappui = changer, même emoji = retirer. */
function NewsReactionBar({ threadId }: { threadId: string }) {
  const { user } = useAuth();
  const cache = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const queryKey = ['news-reactions', user?.id, threadId];
  const { data } = useQuery({
    queryKey, enabled: !!user, staleTime: 15_000, retry: false,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_news_reactions' as never, { p_thread: threadId } as never);
      if (error) throw error;
      return data as unknown as NewsReactions;
    },
  });
  const mutation = useMutation({
    mutationFn: async (reaction: ReactionType | null) => {
      const name = reaction ? 'set_news_reaction' : 'remove_news_reaction';
      const args = reaction ? { p_thread: threadId, p_reaction: reaction } : { p_thread: threadId };
      const { error } = await supabase.rpc(name as never, args as never);
      if (error) throw error;
    },
    onSettled: () => cache.invalidateQueries({ queryKey }),
  });
  const mine = data?.mine ?? null;
  const total = Object.values(data?.counts ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);
  const choose = (reaction: ReactionType) => {
    if (mutation.isPending) return;
    setPickerOpen(false);
    mutation.mutate(mine === reaction ? null : reaction);
  };
  return <div className="relative flex-1">
    {pickerOpen && <div role="group" aria-label="Choisir une réaction"
      className="absolute bottom-full left-1/2 z-20 mb-2 flex -translate-x-1/2 gap-1 rounded-full border border-border/30 bg-card p-1.5 shadow-lg">
      {REACTION_KEYS.map(key => <button key={key} type="button" aria-label={REACTION_LABELS[key]} disabled={mutation.isPending}
        onClick={() => choose(key)}
        className={cn('rounded-full p-1 text-xl transition-transform hover:scale-125', mine === key && 'bg-primary/15')}>
        {REACTION_EMOJIS[key]}
      </button>)}
    </div>}
    <Button type="button" variant="ghost" size="sm" disabled={mutation.isPending}
      aria-label={mine ? `Ma réaction : ${REACTION_LABELS[mine]}. Appuyer pour changer.` : 'Réagir'}
      onClick={() => {
        if (mutation.isPending) return;
        if (!mine) mutation.mutate('like'); else setPickerOpen(open => !open);
      }}
      className="h-11 w-full gap-1.5 rounded-xl text-xs text-muted-foreground hover:bg-secondary/50 hover:text-foreground">
      <span aria-hidden="true" className="text-base">{mine ? REACTION_EMOJIS[mine] : '👍'}</span>
      <span className="font-medium">{mine ? REACTION_LABELS[mine] : 'Réagir'}</span>
    </Button>
    {total > 0 && <span className="sr-only">{total} réaction{total !== 1 ? 's' : ''}</span>}
  </div>;
}

function PartnerCard({ item }: { item: PartnerMediaItem }) {
  const [playing, setPlaying] = useState(false);
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const url = safePartnerUrl(item.canonical_url);
  const thumbnail = imageFailed ? null : partnerThumbnailUrl(item.id, item.thumbnail_url);
  const embed = youtubeEmbedUrl(item.youtube_id);
  if (!url) return null;
  return <article className="overflow-hidden rounded-xl border border-border bg-card">
    <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Ouvrir chez ${item.source_name} : ${item.title}`}
      className="relative block aspect-video overflow-hidden bg-gradient-to-br from-primary/20 via-muted to-secondary/30">
      {thumbnail ? <img src={thumbnail} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
        className="h-full w-full object-cover" onError={() => setImageFailed(true)} />
        : <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground" data-testid="partner-media-fallback">
          <Newspaper className="h-10 w-10" aria-hidden="true" />
          <span className="text-sm font-medium">{item.kind === 'video' ? 'Aperçu vidéo' : 'Aperçu de l’actualité'}</span>
        </span>}
      {item.kind === 'video' && <span className="absolute inset-0 grid place-items-center bg-black/20" aria-hidden="true"><span className="grid h-12 w-12 place-items-center rounded-full bg-black/70 text-white"><Play className="h-6 w-6 fill-current" /></span></span>}
    </a>
    <div className="p-3 space-y-2">
    <p className="text-xs text-muted-foreground">{item.source_name} · {editorialCategoryLabel[item.editorial_category ?? 'general']} · {item.kind === 'video' ? 'Vidéo' : 'Article'} · {new Date(item.published_at).toLocaleDateString('fr-FR')}</p>
    <p className="text-xs text-muted-foreground">{[item.city, item.region].filter(Boolean).join(' · ') || 'France'}{item.proximity === 'national' ? ' · Sélection nationale' : ''}</p>
    {item.rank_reason && <p className="text-xs font-medium text-primary">{rankReasonLabel[item.rank_reason] ?? 'Sélection du feed'}</p>}
    <a className="block font-semibold leading-snug hover:underline" href={url} target="_blank" rel="noopener noreferrer">{item.title}</a>
    {item.excerpt && <p className="text-sm text-muted-foreground">{item.excerpt}</p>}
    {item.discussion_id && <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant={discussionOpen ? 'secondary' : 'outline'} aria-expanded={discussionOpen}
        onClick={() => setDiscussionOpen(value => !value)}><MessageCircle className="mr-1 h-4 w-4" />{discussionOpen ? 'Fermer les commentaires' : 'Commenter et débattre'}</Button>
      <Link className="text-sm underline" to={`/news/${item.discussion_id}`}>Ouvrir la discussion</Link>
      <Suspense fallback={null}><ShareNews url={`${window.location.origin}/news/${item.discussion_id}`} title={`Discussion · ${item.source_name}`} showLabel size="sm" /></Suspense>
    </div>}
    {embed && (playing ? <iframe title={item.title} src={embed} className="w-full aspect-video rounded-lg"
      referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" allow="encrypted-media; fullscreen; picture-in-picture" allowFullScreen />
      : <div><Button variant="outline" onClick={() => setPlaying(true)}>Charger la vidéo YouTube</Button>
        <p className="text-xs text-muted-foreground">Ce clic établit une connexion avec YouTube. Aucun lecteur tiers n’est chargé avant.</p></div>)}
    {discussionOpen && item.discussion_id && <Suspense fallback={<p role="status">Chargement des commentaires…</p>}>
      <Discussion threadId={item.discussion_id} compact />
    </Suspense>}
    </div>
  </article>;
}

type LocalMediaSectionProps = {
  variant?: 'section' | 'feed-card';
  itemIndex?: number;
  maxItems?: number;
};

export function LocalMediaSection({ variant = 'section', itemIndex = 0, maxItems = 16 }: LocalMediaSectionProps) {
  const { user } = useAuth();
  const [kind, setKind] = useState<MediaKind>('all');
  const effectiveKind: MediaKind = variant === 'feed-card' ? 'all' : kind;
  const browserLocale = browserLocaleContext();
  const languages = browserLocale.languages.join(',');
  const { data: context } = useQuery({
    queryKey: ['media-context', user?.id, languages, browserLocale.timeZone],
    enabled: !!user,
    staleTime: 3_600_000, retry: false, refetchOnWindowFocus: false,
    queryFn: async () => {
      const browser = await browserLocationContext();
      const { data, error } = await supabase.functions.invoke('local-media-location', {
        body: { context: true, browser },
        headers: { 'Accept-Language': languages },
      });
      if (error) throw error;
      return (data?.location ?? null) as MediaContext | null;
    },
  });
  const location = context;
  const automatic = !!context?.region;
  const effectiveScope: MediaScope = automatic ? 'nearby' : 'france';
  const { data = [], isLoading, isError } = useQuery({
    queryKey: ['partner-media', user?.id, effectiveScope, effectiveKind, location?.country, location?.region, location?.city],
    enabled: !!user, staleTime: 60_000, retry: false,
    queryFn: async () => {
      const { data: items, error } = await supabase.rpc('get_contextual_partner_media' as never, {
        p_scope: effectiveScope, p_kind: effectiveKind, p_country: context?.country ?? 'FR',
        p_region: context?.region ?? '', p_city: context?.city ?? null,
      } as never);
      if (error) throw error;
      return (items ?? []) as unknown as PartnerMediaItem[];
    },
  });

  if (variant === 'feed-card') {
    if (isLoading) return <div className="h-40 skeleton rounded-2xl" role="status" aria-label="Chargement d’une actualité" />;
    if (isError || !data[itemIndex]) return null;
    return <section className="space-y-2" aria-label="Actualité recommandée dans le feed">
      <p className="px-1 text-xs font-semibold text-muted-foreground">Actualité choisie selon tes réglages</p>
      <PartnerCard item={data[itemIndex]} />
    </section>;
  }

  return <section className="rounded-2xl bg-card border border-border p-4 space-y-3" aria-labelledby="local-media-title">
    <h2 id="local-media-title" className="font-semibold">Médias et actualités</h2>
    <p className="text-xs text-muted-foreground">Sélection automatique : actualité locale, science, musique, éducation, sport et bien-être, classées selon tes priorités du feed.</p>
    <label className="block text-sm">Format <select className="ml-2 bg-background border rounded p-1" value={kind} onChange={e => setKind(e.target.value as MediaKind)}>
      <option value="all">Tous</option><option value="article">Articles</option><option value="video">Vidéos</option>
    </select></label>
    {automatic ? <Link to="/settings?tab=privacy#discovery-heading" className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2">
      <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
      {context.source === 'profile' ? 'Ville du profil' : context.source === 'selected' ? 'Zone du compte' : 'Zone navigateur + IP'} : {[context.display?.city ?? context.city, context.display?.region ?? context.region].filter(Boolean).join(' · ')} · Modifier
    </Link> : <Link to="/settings?tab=privacy#discovery-heading" className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2">
      <MapPin className="h-3.5 w-3.5" aria-hidden="true" />Zone automatique indisponible · Choisir ma ville
    </Link>}
    <GeoAttribution />
    {isLoading ? <p role="status">Chargement des médias…</p> : isError ? <p role="status">Médias momentanément indisponibles. Ton feed reste accessible.</p>
      : data.length === 0 ? <p className="text-sm text-muted-foreground">Aucun contenu partenaire autorisé disponible dans cette zone pour le moment.</p>
        : data.slice(0, Math.max(1, maxItems)).map(item => <PartnerCard key={item.id} item={item} />)}
  </section>;
}
