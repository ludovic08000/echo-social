import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import { ZEUS_CAPABILITY_IDS } from '@/lib/zeusCapabilities';

const policySchema = z.object({ capability: z.enum(ZEUS_CAPABILITY_IDS), enabled: z.boolean(), minimum_confirmation: z.boolean(), require_confirmation: z.boolean(), required_role: z.enum(['admin', 'moderator', 'user']).nullable(), paid_only: z.boolean(), revision: z.number().int().positive() });
type Policy = z.infer<typeof policySchema>;
const labels: Record<Policy['capability'], string> = {
  'activity.read': 'Lire le bilan', 'messages.send': 'Envoyer un message', 'calls.start': 'Lancer un appel', 'posts.publish': 'Publier',
  'friend_requests.list': 'Lister les demandes d’amis', 'friend_requests.show_profile': 'Afficher un profil', 'friend_requests.respond': 'Répondre à une demande d’ami',
  'feed.preferences.update': 'Personnaliser le feed', 'appearance.feed.update': 'Personnaliser l’apparence',
};

export function ZeusCapabilitiesPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const policies = useQuery({ queryKey: ['zeus-capability-policies'], queryFn: async () => {
    const result = await supabase.rpc('zeus_capability_policies');
    if (result.error) throw new Error('Lecture des droits Zeus indisponible.');
    return z.array(policySchema).parse(result.data);
  } });
  const update = async (policy: Policy, patch: Partial<Policy>) => {
    setBusy(true); setError('');
    try {
      const next = { ...policy, ...patch };
      const result = await supabase.rpc('zeus_set_capability_policy', { p_capability: next.capability, p_enabled: next.enabled, p_required_role: next.required_role, p_paid_only: next.paid_only, p_confirmation: next.require_confirmation, p_revision: policy.revision });
      const saved = policySchema.safeParse(result.data);
      if (result.error || !saved.success || saved.data.capability !== policy.capability || saved.data.revision !== policy.revision + 1) throw new Error('La modification n’est pas confirmée. Recharge les droits avant de réessayer.');
      await policies.refetch();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Modification indisponible.'); }
    finally { setBusy(false); }
  };
  return <details className="mx-2 mb-3 rounded-xl border border-border bg-card p-3">
    <summary className="cursor-pointer font-medium">Capacités Zeus</summary>
    <p className="mt-2 text-xs text-muted-foreground">Ces droits concernent Zeus. Les confirmations minimales restent obligatoires. Chaque modification est enregistrée côté serveur.</p>
    {(error || policies.isError) && <p role="alert" className="mt-2 text-sm text-destructive">{error || 'Lecture des droits Zeus indisponible.'}</p>}
    <div className="mt-2 max-h-72 space-y-3 overflow-auto">
      {(policies.data || []).map(policy => <fieldset key={policy.capability} disabled={busy} className="rounded-lg border p-2 text-xs">
        <legend>{labels[policy.capability]}</legend>
        <label className="mr-3"><input type="checkbox" checked={policy.enabled} onChange={event => void update(policy, { enabled: event.target.checked })} /> Activée</label>
        <label className="mr-3"><input type="checkbox" checked={policy.paid_only} onChange={event => void update(policy, { paid_only: event.target.checked })} /> Créateur abonné</label>
        <label><input type="checkbox" checked={policy.require_confirmation} disabled={policy.minimum_confirmation} onChange={event => void update(policy, { require_confirmation: event.target.checked })} /> Confirmation</label>
        <label className="mt-2 block">Rôle requis <select value={policy.required_role || ''} onChange={event => void update(policy, { required_role: (event.target.value || null) as Policy['required_role'] })} className="ml-2 rounded border bg-background p-1">
          <option value="">Tous les membres</option><option value="user">Membre</option><option value="moderator">Modérateur</option><option value="admin">Administrateur</option>
        </select></label>
      </fieldset>)}
    </div>
  </details>;
}
