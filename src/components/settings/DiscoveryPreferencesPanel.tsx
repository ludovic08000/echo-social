import { useEffect, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  useDiscoveryPreferences,
  useSaveDiscoveryPreferences,
  useSaveNewsDiscoveryPreferences,
} from '@/hooks/useDiscoveryPreferences';
import { DEFAULT_DISCOVERY, type DiscoveryPreferences } from '@/lib/discovery';
import { supabase } from '@/integrations/supabase/client';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth';
import { GeoAttribution } from '@/components/geo/GeoAttribution';
import { browserLocationContext } from '@/lib/browserLocation';

type PlaceProposal = { country: string; region: string | null; city: string | null; department?: string; code?: string;
  display?: { country: string; region: string | null; city: string | null } };

export function DiscoveryPreferencesPanel() {
  const { user } = useAuth();
  return <AccountDiscoveryPreferences key={user?.id ?? 'signed-out'} />;
}

function AccountDiscoveryPreferences() {
  const { data, isLoading, isError } = useDiscoveryPreferences();
  const saveAds = useSaveDiscoveryPreferences();
  const saveNews = useSaveNewsDiscoveryPreferences();
  const [draft, setDraft] = useState<DiscoveryPreferences>(DEFAULT_DISCOVERY);
  const [detecting, setDetecting] = useState(false);
  const [query, setQuery] = useState('');
  const [proposals, setProposals] = useState<PlaceProposal[]>([]);
  const dirty = useRef(false);
  const request = useRef(0);
  const saving = saveAds.isPending || saveNews.isPending;
  useEffect(() => () => { request.current++; }, []);
  useEffect(() => { if (data && !dirty.current) setDraft(data); }, [data]);
  const patch = (value: Partial<DiscoveryPreferences>) => {
    dirty.current = true;
    setDraft(current => ({ ...current, ...value }));
  };
  const patchMediaLocation = (value: Partial<Pick<DiscoveryPreferences, 'country' | 'region' | 'city'>>) => {
    patch({ local_media: true, ...value });
  };

  const suggest = async (mode: 'ip' | 'profile' | 'search') => {
    const ticket = ++request.current;
    setDetecting(true);
    setProposals([]);
    try {
      let cityQuery = query.trim();
      if (mode === 'profile') {
        const { data: city, error } = await supabase.rpc('get_my_media_profile_city' as never);
        const profileCity: unknown = city;
        if (error || typeof profileCity !== 'string' || profileCity.trim().length < 2) throw new Error('PROFILE_CITY_MISSING');
        cityQuery = profileCity;
      }
      if (request.current !== ticket) return;
      const browser = mode === 'ip' ? await browserLocationContext() : null;
      const { data: result, error } = await supabase.functions.invoke('local-media-location', {
        body: mode === 'ip' ? { consent: true, browser } : { cityQuery },
        ...(mode === 'ip' ? { headers: { 'Accept-Language': browser?.languages.join(',') ?? '' } } : {}),
      });
      if (request.current !== ticket) return;
      if (error) throw error;
      const rows: PlaceProposal[] = mode === 'ip' ? (result?.country ? [result] : []) : (Array.isArray(result?.cities) ? result.cities : []);
      setProposals(rows);
      if (!rows.length) toast.info('Aucune commune trouvée. Précise le nom ou le code postal, ou saisis ta zone manuellement.');
    } catch {
      if (request.current === ticket) toast.error(mode === 'profile' ? 'Ville du profil absente ou recherche indisponible. Saisis ta ville manuellement.' : 'Recherche indisponible : choisis ta ville manuellement.');
    } finally { if (request.current === ticket) setDetecting(false); }
  };

  if (isLoading) return <p role="status">Chargement des préférences…</p>;
  if (isError) return <p role="status">Les préférences ne sont pas encore disponibles.</p>;
  return <section className="rounded-xl border border-border p-4 space-y-4" aria-labelledby="discovery-heading">
    <h3 id="discovery-heading" className="font-semibold">Actualités locales</h3>
    <p className="text-sm text-muted-foreground">ForSure choisit automatiquement les médias de ta ville, puis de ta région et enfin de France. Tu peux corriger la zone proposée ici, sans activer la publicité personnalisée.</p>
    <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1">
      <p className="text-sm font-medium">Les actualités locales sont disponibles pour tous les comptes</p>
      <p className="text-xs text-muted-foreground">La ville du profil est prioritaire, puis les signaux du navigateur et l’IP réseau approximative, avec repli sur la France. Aucune IP ni coordonnée n’est enregistrée ici.</p>
    </div>
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Une zone choisie manuellement est prioritaire et n’est jamais écrasée par le réseau. Aucun message ni autre champ du compte n’est analysé pour choisir les journaux.</p>
      <Button type="button" variant="outline" disabled={detecting || saving} onClick={() => void suggest('profile')}>Utiliser la ville de mon profil</Button>
      <label className="block text-sm">Rechercher une commune française ou un code postal<Input disabled={detecting || saving} value={query} maxLength={100} onChange={e => setQuery(e.target.value)} /></label>
      <Button type="button" variant="outline" disabled={detecting || saving || query.trim().length < 2} onClick={() => void suggest('search')}>Rechercher la commune</Button>
      <p className="text-xs text-muted-foreground">La recherche consulte l’annuaire officiel des communes via ForSure. Seul le nom ou le code postal recherché est transmis, sans identifiant de compte ni IP du navigateur.</p>
      <label className="block text-sm">Pays (code à deux lettres)<Input disabled={detecting || saving} value={draft.country ?? ''} maxLength={2} placeholder="FR" onChange={e => patchMediaLocation({ country: e.target.value })} /></label>
      <label className="block text-sm">Région<Input disabled={detecting || saving} value={draft.region ?? ''} maxLength={100} placeholder="Grand Est" onChange={e => patchMediaLocation({ region: e.target.value })} /></label>
      <label className="block text-sm">Ville<Input disabled={detecting || saving} value={draft.city ?? ''} maxLength={100} placeholder="Reims" onChange={e => patchMediaLocation({ city: e.target.value })} /></label>
      <Button type="button" variant="outline" disabled={detecting || saving} onClick={() => { request.current++; setProposals([]); patch({ local_media: false, country: null, region: null, city: null }); }}>Effacer la zone choisie</Button>
      <p className="text-xs text-muted-foreground">ForSure combine le fuseau et les langues du navigateur avec l’adresse IP vue par la passerelle. La base privée DB-IP est utilisée lorsqu’elle est disponible ; à défaut, l’API HTTPS DB-IP retourne une ville et une région approximatives. Aucune IP ni coordonnée n’est enregistrée dans tes préférences. Un VPN, Relais privé ou réseau mobile peut indiquer une autre ville.</p>
      <GeoAttribution />
      <Button type="button" variant="outline" disabled={detecting || saving} onClick={() => void suggest('ip')}><MapPin className="w-4 h-4 mr-2" />{detecting ? 'Recherche…' : 'Détecter avec le navigateur et l’IP'}</Button>
      {proposals.length > 0 && <div role="group" aria-label="Zones proposées" className="space-y-2">
        <p className="text-sm">Choisis la bonne zone, puis enregistre tes choix :</p>
        {proposals.map((place, i) => <Button key={place.code ?? i} type="button" variant="outline" className="h-auto whitespace-normal" onClick={() => {
          patchMediaLocation({ country: place.country, region: place.region, city: place.city }); setProposals([]);
        }}>{[place.display?.city ?? place.city, place.department, place.display?.region ?? place.region, place.display?.country ?? place.country].filter(Boolean).join(' · ')}</Button>)}
      </div>}
      <Button type="button" disabled={saving || detecting} onClick={() => {
        saveNews.mutate(draft, {
          onSuccess: () => toast.success('Zone des actualités enregistrée'),
          onError: () => toast.error('Impossible d’enregistrer la zone des actualités pour le moment.'),
        });
      }}>{saveNews.isPending ? 'Enregistrement…' : 'Enregistrer la zone des actualités'}</Button>
    </div>
    <div className="border-t border-border pt-4 space-y-4">
      <div>
        <h4 className="font-semibold">Publicités personnalisées (facultatif)</h4>
        <p className="text-sm text-muted-foreground">Ces options sont distinctes des actualités. Aucun message privé n’est analysé et aucune catégorie sensible n’est proposée aux annonceurs.</p>
      </div>
    {([
      ['ads_profile', 'Publicités selon mes intérêts déclarés', 'Utiliser les centres d’intérêt non sensibles de mon profil et ma tranche d’âge.'],
      ['ads_activity', 'Publicités selon mon activité publique', 'Déduire des thèmes généraux de mes nouvelles publications, commentaires publics et vidéos du feed regardées. Nécessite aussi les statistiques et le partage IA activés. Aucun historique antérieur au consentement.'],
      ['ads_location', 'Publicités de ma ville et de ma région', 'Réutiliser la zone choisie ci-dessus pour les publicités. Indépendant des actualités locales et désactivable à tout moment.'],
      ['ads_location_auto', 'Trouver automatiquement ma zone publicitaire', 'Si aucune zone n’est choisie : utiliser ma ville de profil, sinon une estimation réseau avec la base DB-IP privée lorsqu’elle est configurée. Sans GPS ; la zone est valable 15 minutes par session puis purgée au nettoyage périodique, sans IP ni coordonnées enregistrées.'],
    ] as const).map(([key, label, help]) => <div key={key} className="flex items-start justify-between gap-4">
      <div><label htmlFor={`discovery-${key}`} className="text-sm font-medium">{label}</label><p className="text-xs text-muted-foreground">{help}</p></div>
      <Switch id={`discovery-${key}`} checked={draft[key]} onCheckedChange={value => patch(key === 'ads_location' && !value ? { ads_location: false, ads_location_auto: false } : { [key]: value })}
        disabled={saving || detecting || (key === 'ads_location_auto' && !draft.ads_location)} />
    </div>)}
      {draft.ads_location_auto && <p className="text-xs text-muted-foreground">La détection automatique ne s’applique que si les trois champs sont vides. Une région seule ne sert jamais à inventer ta ville. Si la zone n’est pas disponible, seules les campagnes générales éligibles sont proposées.</p>}
      <Button type="button" disabled={saving || detecting} onClick={() => {
        saveAds.mutate(draft, { onSuccess: () => toast.success('Choix publicitaires enregistrés'), onError: () => {
          const requestsPersonalizedAds = draft.ads_profile || draft.ads_activity || draft.ads_location || draft.ads_location_auto;
          toast.error(requestsPersonalizedAds
            ? 'La personnalisation publicitaire n’est pas disponible pour ce compte. Les actualités restent disponibles.'
            : 'Impossible d’enregistrer ces choix publicitaires pour le moment.');
        } });
      }}>{saveAds.isPending ? 'Enregistrement…' : 'Enregistrer mes choix publicitaires'}</Button>
    </div>
    <p className="text-xs text-muted-foreground">Désactiver l’activité efface ses thèmes dérivés. <Link className="underline" to="/privacy">Informations sur les données utilisées</Link></p>
  </section>;
}
