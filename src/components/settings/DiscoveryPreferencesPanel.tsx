import { useEffect, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useDiscoveryPreferences, useSaveDiscoveryPreferences } from '@/hooks/useDiscoveryPreferences';
import { DEFAULT_DISCOVERY, type DiscoveryPreferences } from '@/lib/discovery';
import { supabase } from '@/integrations/supabase/client';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth';
import { GeoAttribution } from '@/components/geo/GeoAttribution';

type PlaceProposal = { country: string; region: string | null; city: string | null; department?: string; code?: string;
  display?: { country: string; region: string | null; city: string | null } };

export function DiscoveryPreferencesPanel() {
  const { user } = useAuth();
  return <AccountDiscoveryPreferences key={user?.id ?? 'signed-out'} />;
}

function AccountDiscoveryPreferences() {
  const { data, isLoading, isError } = useDiscoveryPreferences();
  const save = useSaveDiscoveryPreferences();
  const [draft, setDraft] = useState<DiscoveryPreferences>(DEFAULT_DISCOVERY);
  const [detecting, setDetecting] = useState(false);
  const [query, setQuery] = useState('');
  const [proposals, setProposals] = useState<PlaceProposal[]>([]);
  const dirty = useRef(false);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  useEffect(() => { if (data && !dirty.current) setDraft(data); }, [data]);
  const patch = (value: Partial<DiscoveryPreferences>) => {
    dirty.current = true;
    setDraft(current => ({ ...current, ...value }));
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
      const { data: result, error } = await supabase.functions.invoke('local-media-location', {
        body: mode === 'ip' ? { consent: true } : { cityQuery },
        ...(mode === 'ip' ? { headers: { 'Accept-Language': navigator.languages.join(',') } } : {}),
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

  if (isLoading) return <p role="status">Chargement des préférences publicitaires et locales…</p>;
  if (isError) return <p role="status">Les préférences publicitaires et locales ne sont pas encore disponibles.</p>;
  return <section className="rounded-xl border border-border p-4 space-y-4" aria-labelledby="discovery-heading">
    <h3 id="discovery-heading" className="font-semibold">Publicités et médias locaux</h3>
    <p className="text-sm text-muted-foreground">Le ciblage publicitaire est facultatif, désactivé par défaut et réservé aux adultes. Aucun message privé n’est analysé et aucune catégorie sensible n’est proposée aux annonceurs.</p>
    <p className="text-sm text-muted-foreground">Les actualités utilisent automatiquement la ville du profil, sinon une région réseau approximative, avec repli sur la France. Aucun GPS et aucune IP ne sont enregistrés dans ces préférences. Ce fonctionnement est indépendant du ciblage publicitaire.</p>
    {([
      ['ads_profile', 'Publicités selon mes intérêts déclarés', 'Utiliser les centres d’intérêt non sensibles de mon profil et ma tranche d’âge.'],
      ['ads_activity', 'Publicités selon mon activité publique', 'Déduire des thèmes généraux de mes nouvelles publications, commentaires publics et vidéos du feed regardées. Nécessite aussi les statistiques et le partage IA activés. Aucun historique antérieur au consentement.'],
      ['ads_location', 'Publicités de ma ville et de ma région', 'Utiliser ma zone choisie pour les publicités. Indépendant des actualités locales et désactivable à tout moment.'],
      ['ads_location_auto', 'Trouver automatiquement ma zone publicitaire', 'Si aucune zone n’est choisie : utiliser ma ville de profil, sinon une estimation réseau avec la base DB-IP hébergée par ForSure. Mon IP n’est pas transmise à DB-IP. Sans GPS ; la zone est valable 15 minutes par session puis purgée au nettoyage périodique, sans IP ni coordonnées enregistrées.'],
    ] as const).map(([key, label, help]) => <div key={key} className="flex items-start justify-between gap-4">
      <div><label htmlFor={`discovery-${key}`} className="text-sm font-medium">{label}</label><p className="text-xs text-muted-foreground">{help}</p></div>
      <Switch id={`discovery-${key}`} checked={draft[key]} onCheckedChange={value => patch(key === 'ads_location' && !value ? { ads_location: false, ads_location_auto: false } : { [key]: value })}
        disabled={save.isPending || detecting || (key === 'ads_location_auto' && !draft.ads_location)} />
    </div>)}
    {draft.ads_location && <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Ta zone enregistrée est prioritaire et n’est jamais écrasée par le réseau. Aucun autre champ du compte n’est analysé pour choisir les journaux.</p>
      <Button type="button" variant="outline" disabled={detecting || save.isPending} onClick={() => void suggest('profile')}>Utiliser la ville de mon profil</Button>
      <label className="block text-sm">Rechercher une commune française ou un code postal<Input disabled={detecting || save.isPending} value={query} maxLength={100} onChange={e => setQuery(e.target.value)} /></label>
      <Button type="button" variant="outline" disabled={detecting || save.isPending || query.trim().length < 2} onClick={() => void suggest('search')}>Rechercher la commune</Button>
      <p className="text-xs text-muted-foreground">La recherche consulte l’annuaire officiel des communes via ForSure. Seul le nom ou le code postal recherché est transmis, sans identifiant de compte ni IP du navigateur.</p>
      <label className="block text-sm">Pays (code à deux lettres)<Input disabled={detecting || save.isPending} value={draft.country ?? ''} maxLength={2} placeholder="FR" onChange={e => patch({ country: e.target.value })} /></label>
      <label className="block text-sm">Région<Input disabled={detecting || save.isPending} value={draft.region ?? ''} maxLength={100} placeholder="Grand Est" onChange={e => patch({ region: e.target.value })} /></label>
      <label className="block text-sm">Ville<Input disabled={detecting || save.isPending} value={draft.city ?? ''} maxLength={100} placeholder="Reims" onChange={e => patch({ city: e.target.value })} /></label>
      <Button type="button" variant="outline" disabled={detecting || save.isPending} onClick={() => { request.current++; setProposals([]); patch({ country: null, region: null, city: null }); }}>Effacer la zone choisie</Button>
      {draft.ads_location_auto && <p className="text-xs text-muted-foreground">La détection automatique ne s’applique que si les trois champs sont vides. Une région seule ne sert jamais à inventer ta ville. Si la zone n’est pas disponible, seules les campagnes générales éligibles sont proposées.</p>}
      <p className="text-xs text-muted-foreground">ForSure estime ta zone avec une copie de DB-IP City Lite, si elle est configurée. Aucun envoi de ton IP à DB-IP, aucun GPS. Un VPN ou un réseau mobile peut indiquer une autre ville : vérifie la proposition ou saisis ta ville. Les noms disponibles suivent les langues de ton navigateur, avec repli lorsqu’une traduction manque.</p>
      <GeoAttribution />
      <Button type="button" variant="outline" disabled={detecting || save.isPending} onClick={() => void suggest('ip')}><MapPin className="w-4 h-4 mr-2" />{detecting ? 'Recherche…' : 'Détecter ma zone avec DB-IP'}</Button>
      {proposals.length > 0 && <div role="group" aria-label="Zones proposées" className="space-y-2">
        <p className="text-sm">Choisis la bonne zone, puis enregistre tes choix :</p>
        {proposals.map((place, i) => <Button key={place.code ?? i} type="button" variant="outline" className="h-auto whitespace-normal" onClick={() => {
          patch({ country: place.country, region: place.region, city: place.city }); setProposals([]);
        }}>{[place.display?.city ?? place.city, place.department, place.display?.region ?? place.region, place.display?.country ?? place.country].filter(Boolean).join(' · ')}</Button>)}
      </div>}
    </div>}
    <Button disabled={save.isPending || detecting} onClick={() => {
      save.mutate(draft, { onSuccess: () => { dirty.current = false; toast.success('Préférences enregistrées'); }, onError: () => toast.error('Enregistrement refusé. Le ciblage exige un compte adulte connu ; vérifie aussi le pays.') });
    }}>{save.isPending ? 'Enregistrement…' : 'Enregistrer mes choix'}</Button>
    <p className="text-xs text-muted-foreground">Désactiver l’activité efface ses thèmes dérivés. <Link className="underline" to="/privacy">Informations sur les données utilisées</Link></p>
  </section>;
}
