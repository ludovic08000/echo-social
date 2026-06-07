/**
 * DevicePrimaryRepairDialog — modale propriétaire-uniquement déclenchée par
 * `useDevicePrimaryRepair` quand le primary device a été perdu et qu'aucune
 * auto-promotion silencieuse n'est possible.
 *
 * - `manual_relink_required` : 2+ devices restants → demander un relink /
 *   approbation depuis un device de confiance.
 * - `no_eligible_device`     : 0 device restant → demander reconnexion +
 *   restauration PIN.
 *
 * Ne déclenche AUCUNE promotion côté front. Se contente d'informer puis de
 * marquer la repair request comme résolue après action utilisateur.
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useDevicePrimaryRepair } from '@/hooks/useDevicePrimaryRepair';
import { supabase } from '@/integrations/supabase/client';

export default function DevicePrimaryRepairDialog() {
  const { pending, dismiss } = useDevicePrimaryRepair();
  if (!pending) return null;

  const isNoEligible = pending.reason === 'no_eligible_device';

  const title = isNoEligible
    ? 'Reconnexion requise'
    : 'Approbation d\'un device requise';

  const description = isNoEligible
    ? 'Plus aucun device de confiance n\'est disponible pour ce compte. Reconnecte-toi puis ré-entre ton code PIN de sauvegarde pour restaurer ton trousseau chiffré.'
    : `Le device principal a été révoqué. Plusieurs devices sont encore actifs (${pending.candidate_device_ids.length}). Pour des raisons de sécurité, l\'auto-promotion est désactivée : connecte-toi depuis un device de confiance et approuve manuellement le device à promouvoir en principal.`;

  const confirmLabel = isNoEligible ? 'Se déconnecter' : 'Compris';

  const handleConfirm = async () => {
    if (isNoEligible) {
      try {
        // Signal Restore Manager that re-unlock will be required after re-login.
        try {
          window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', {
            detail: { source: 'no_eligible_device' },
          }));
        } catch {}
        await supabase.auth.signOut();
      } catch (err) {
        console.warn('[device-primary-repair] sign out failed', err);
      }
    }
    await dismiss();
  };

  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {!isNoEligible && (
            <AlertDialogCancel onClick={() => { void dismiss(); }}>
              Plus tard
            </AlertDialogCancel>
          )}
          <AlertDialogAction onClick={handleConfirm}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
