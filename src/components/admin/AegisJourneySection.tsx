import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type JourneyEvent = {
  id: string; occurred_at: string; user_id: string; session_id: string | null;
  device_ref: string | null; message_id: string | null; stage: string;
  outcome: string; source: string; evidence: string; error_code: string | null;
  request_id: string | null; duration_ms: number | null;
};
const LABELS: Record<string, string> = {
  auth_password_verified: 'Mot de passe vérifié par Auth (pas une approbation d’appareil)',
  auth_password_rejected: 'Mot de passe refusé par Auth',
  client_state_lookup: 'Client : lecture de l’appareil échouée', 'client_step.enrolling': 'Client : enregistrement appareil bloqué',
  'client_step.approving': 'Client : approbation appareil bloquée', 'client_step.binding': 'Client : liaison appareil bloquée',
  'client_step.preparing_keys': 'Client : préparation des clés bloquée', 'client_step.syncing_account': 'Client : synchronisation du compte bloquée',
  aegis_send_message: 'Tentative d’envoi Aegis', aegis_sync_device: 'Synchronisation Aegis', aegis_ack_device_messages: 'Accusé de réception Aegis',
  approval_email_recorded: 'Demande d’e-mail enregistrée (pas encore envoyée)',
  approval_email_queued: 'E-mail mis en file', approval_email_queue_failed: 'Mise en file échouée',
  approval_email_provider_accepted: 'E-mail accepté par le fournisseur (réception non confirmée)',
  approval_email_failed: 'Envoi d’e-mail échoué', approval_email_bounced: 'E-mail rejeté',
  approval_email_rate_limited: 'E-mail retardé : limite fournisseur', approval_email_abandoned: 'Envoi abandonné',
  login_approved: 'Connexion approuvée', login_denied: 'Connexion refusée', login_assessment: 'Connexion évaluée',
  login_device_binding: 'Connexion associée à l’appareil', device_registered: 'Appareil enregistré',
  device_approved: 'Appareil approuvé', device_bound: 'Appareil lié au compte', device_route_ready: 'Route appareil prête',
  device_disabled: 'Appareil désactivé / révoqué', device_enrollment_started: 'Enregistrement appareil commencé',
  device_enrollment_completed: 'Preuve d’enregistrement consommée', device_enrollment_cancelled: 'Enregistrement annulé',
  message_stored: 'Message enregistré côté serveur (pas une preuve de lecture)',
  client_crypto_failure: 'Échec signalé par le client', email_token_consume: 'Consommation de validation',
};

export function AegisJourneySection() {
  const { data: isAdmin } = useIsAdmin();
  const [draft, setDraft] = useState('');
  const [account, setAccount] = useState('');
  const [outcome, setOutcome] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const before = cursors.at(-1);
  const query = useQuery({
    queryKey: ['admin-aegis-journey', account, outcome, before], enabled: isAdmin === true,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_aegis_journey', {
        ...(account ? { p_account: account } : {}), ...(outcome ? { p_outcome: outcome } : {}),
        ...(before ? { p_before_id: Number(before) } : {}),
      });
      if (error) throw error;
      return (Array.isArray(data) ? data : []) as unknown as JourneyEvent[];
    }, staleTime: 5000,
  });
  const events = query.data ?? [];
  return <section className="space-y-4" aria-label="Parcours Aegis">
    <h2 className="text-xl font-semibold">Parcours Aegis : connexion → appareil → message</h2>
    <p className="text-sm text-muted-foreground">Événements des 30 derniers jours, plus récents en premier. Heures locales et UTC. Aucun contenu, clé ou lien d’approbation. La collecte commence à l’activation du journal.</p>
    <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); setAccount(draft.trim()); setCursors([]); }}>
      <Input aria-label="Adresse e-mail ou identifiant du compte" placeholder="E-mail ou UUID du compte" value={draft} onChange={e => setDraft(e.target.value)} className="max-w-md" />
      <Button type="submit">Rechercher</Button>
      <select aria-label="Résultat" className="rounded-md border bg-background px-3" value={outcome} onChange={e => { setOutcome(e.target.value); setCursors([]); }}>
        <option value="">Tous les résultats</option><option value="success">Succès</option><option value="failure">Échecs</option><option value="info">Informations</option>
      </select>
      <Button type="button" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>Actualiser</Button>
    </form>
    {query.isError ? <p role="alert">Journal indisponible : vérifier les droits administrateur et l’activation de la migration Lovable Cloud. Aucun résultat ne peut être confirmé.</p> : null}
    {query.isLoading ? <p role="status">Chargement du parcours…</p> : null}
    {!query.isLoading && !query.isError && events.length === 0 ? <p>Aucun événement enregistré pour ces filtres. Cela ne signifie pas que l’activation a réussi.</p> : null}
    <ol className="space-y-3" aria-busy={query.isFetching}>
      {events.map(event => <li key={event.id} className="rounded-xl border p-4 space-y-1 break-words">
        <div className="flex flex-wrap justify-between gap-2"><strong>{LABELS[event.stage] ?? event.stage}</strong><span>{event.outcome === 'success' ? 'Succès' : event.outcome === 'failure' ? 'Échec' : 'Information'}</span></div>
        <time dateTime={event.occurred_at}>{new Date(event.occurred_at).toLocaleString('fr-FR')} · {new Date(event.occurred_at).toISOString()}</time>
        <p className="text-sm text-muted-foreground">{event.evidence === 'client_report' ? 'Déclaration client — non probante côté serveur' : event.evidence === 'transport_report' ? 'Rapport transport — compte authentifié, résultat déclaratif' : 'Événement serveur'} · Source : {event.source} · #{event.id}</p>
        <p className="text-xs font-mono">Compte : {event.user_id}<br />Session : {event.session_id ?? 'Non corrélée'} · Appareil : {event.device_ref ?? 'Non renseigné'}{event.message_id ? <><br />Message : {event.message_id}</> : null}</p>
        {event.error_code ? <p className="text-sm text-destructive">{event.error_code}</p> : null}
        {event.request_id ? <p className="text-xs font-mono">Diagnostic Vercel : {event.request_id} · {event.duration_ms} ms</p> : null}
      </li>)}
    </ol>
    <div className="flex gap-2"><Button variant="outline" disabled={!cursors.length || query.isFetching} onClick={() => setCursors(v => v.slice(0,-1))}>Page précédente</Button>
      <Button variant="outline" disabled={events.length < 100 || query.isFetching} onClick={() => setCursors(v => [...v, events[events.length-1].id])}>Plus anciens</Button></div>
  </section>;
}
