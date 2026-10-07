import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { type MediaScope, type MediaKind, type PartnerMediaItem, safePartnerUrl, youtubeEmbedUrl } from '@/lib/discovery';
import { Button } from '@/components/ui/button';
import { GeoAttribution } from '@/components/geo/GeoAttribution';
const ShareNews = lazy(() => import('@/components/ShareButton').then(m => ({ default: m.ShareButton })));
type MediaContext = { country: string; region: string; city: string | null; source: string;
  display?: { country: string; region: string | null; city: string | null } };

function PartnerCard({ item }: { item: PartnerMediaItem }) {
  const [playing, setPlaying] = useState(false);
  const url = safePartnerUrl(item.canonical_url);
  const embed = youtubeEmbedUrl(item.youtube_id);
  if (!url) return null;
  return <article className="rounded-lg border border-border p-3 space-y-2">
    <p className="text-xs text-muted-foreground">{item.source_name} · {item.kind === 'video' ? 'Vidéo' : 'Actualité'} · {new Date(item.published_at).toLocaleDateString('fr-FR')}</p>
    <p className="text-xs text-muted-foreground">{[item.city, item.region].filter(Boolean).join(' · ') || 'France'}{item.proximity === 'national' ? ' · Sélection nationale' : ''}</p>
    <a className="font-medium underline" href={url} target="_blank" rel="noopener noreferrer">{item.title}</a>
    {item.excerpt && <p className="text-sm text-muted-foreground">{item.excerpt}</p>}
    {item.discussion_id && <div className="flex items-center gap-3">
      <Link className="text-sm underline" to={`/news/${item.discussion_id}`}>Commenter et débattre</Link>
      <Suspense fallback={null}><ShareNews url={`${window.location.origin}/news/${item.discussion_id}`} title={`Discussion · ${item.source_name}`} showLabel size="sm" /></Suspense>
    </div>}
    {embed && (playing ? <iframe title={item.title} src={embed} className="w-full aspect-video rounded-lg"
      referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" allow="encrypted-media; fullscreen; picture-in-picture" allowFullScreen />
      : <div><Button variant="outline" onClick={() => setPlaying(true)}>Charger la vidéo YouTube</Button>
        <p className="text-xs text-muted-foreground">Ce clic établit une connexion avec YouTube. Aucun lecteur tiers n’est chargé avant.</p></div>)}
  </article>;
}

export function LocalMediaSection() {
  const { user } = useAuth();
  const [kind, setKind] = useState<MediaKind>('all');
  const languages = navigator.languages.join(',');
  const { data: context } = useQuery({
    queryKey: ['media-context', user?.id, languages],
    enabled: !!user,
    staleTime: 600_000, retry: false, refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('local-media-location', { body: { context: true }, headers: { 'Accept-Language': languages } });
      if (error) throw error;
      return (data?.location ?? null) as MediaContext | null;
    },
  });
  const location = context;
  const automatic = !!context?.region;
  const effectiveScope: MediaScope = automatic ? 'nearby' : 'france';
  const { data = [], isLoading, isError } = useQuery({
    queryKey: ['partner-media', user?.id, effectiveScope, kind, location?.country, location?.region, location?.city],
    enabled: !!user, staleTime: 60_000, retry: false,
    queryFn: async () => {
      const { data: items, error } = await supabase.rpc('get_contextual_partner_media' as never, {
        p_scope: effectiveScope, p_kind: kind, p_country: context?.country ?? 'FR',
        p_region: context?.region ?? '', p_city: context?.city ?? null,
      } as never);
      if (error) throw error;
      return (items ?? []) as unknown as PartnerMediaItem[];
    },
  });
  return <section className="rounded-2xl bg-card border border-border p-4 space-y-3" aria-labelledby="local-media-title">
    <h2 id="local-media-title" className="font-semibold">Médias et actualités</h2>
    <p className="text-xs text-muted-foreground">Sélection automatique : ta ville si elle est connue, puis ta région, puis les actualités nationales autorisées.</p>
    <label className="block text-sm">Format <select className="ml-2 bg-background border rounded p-1" value={kind} onChange={e => setKind(e.target.value as MediaKind)}>
      <option value="all">Tous</option><option value="article">Articles</option><option value="video">Vidéos</option>
    </select></label>
    {automatic && <p className="text-xs text-muted-foreground">{context.source === 'profile' ? 'Ville du profil' : context.source === 'selected' ? 'Zone du compte' : 'Région approximative du réseau'} : {[context.display?.city ?? context.city, context.display?.region ?? context.region].filter(Boolean).join(' · ')}.</p>}
    <GeoAttribution />
    <Link to="/privacy" className="text-xs underline">Voir comment la zone est déterminée</Link>
    {isLoading ? <p role="status">Chargement des médias…</p> : isError ? <p role="status">Médias momentanément indisponibles. Ton feed reste accessible.</p>
      : data.length === 0 ? <p className="text-sm text-muted-foreground">Aucun contenu partenaire autorisé disponible dans cette zone pour le moment.</p>
        : data.map(item => <PartnerCard key={item.id} item={item} />)}
  </section>;
}
