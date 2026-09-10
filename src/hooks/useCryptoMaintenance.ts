/**
 * useCryptoMaintenance — maintenance périodique des préclés X3DH.
 *
 * Invariant cryptographique : ce hook ne PRÉPARE plus aucun appareil. La
 * préparation initiale (identité, libsignal, SPK, OPK, route, synchronisation)
 * appartient exclusivement à `deviceLifecycleController` via `deviceApi`.
 * Ici, on se contente de renouveler la préclé signée expirante et de recharger
 * le pool de préclés à usage unique, uniquement lorsque l'état serveur est
 * complet (approuvé, actif, lié, route prête, `lifecycle_status='ready'`), le
 * PIN déverrouillé et la synchronisation de compte réussie. La maintenance
 * partage le verrou de `deviceApi.prepareKeys` et ne modifie jamais
 * `routing_status` ni `lifecycle_status`.
 */

import { useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import { deviceApi } from '@/lib/api/deviceApi';
import { useDeviceLifecycle } from '@/hooks/useDeviceLifecycle';

const MAINTENANCE_TTL = 6 * 60 * 60 * 1000; // 6h entre deux maintenances
const STORAGE_KEY = 'forsure-crypto-maintenance-ts';

/** Garde globale : plusieurs montages ne déclenchent qu'une exécution. */
let _maintenancePromise: Promise<void> | null = null;

export function useCryptoMaintenance() {
  const { user } = useAuth();
  const lifecycle = useDeviceLifecycle();
  const ranRef = useRef(false);

  const ready = lifecycle.canRunCryptoRuntime
    && lifecycle.pinUnlocked
    && lifecycle.accountSyncPhase === 'ready'
    && lifecycle.record?.routingStatus === 'ready'
    && lifecycle.record?.lifecycleStatus === 'ready';

  useEffect(() => {
    if (!user || !ready || ranRef.current) return;
    ranRef.current = true;

    try {
      const last = Number(localStorage.getItem(STORAGE_KEY) || '0');
      if (Date.now() - last < MAINTENANCE_TTL) return;
    } catch { /* stockage indisponible : on tente la maintenance */ }

    if (_maintenancePromise) return;

    _maintenancePromise = (async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await deviceApi.runKeyMaintenance(user.id);
        try {
          localStorage.setItem(STORAGE_KEY, String(Date.now()));
        } catch { /* best effort */ }
      } catch (error) {
        // La maintenance est non bloquante : elle ne change aucun état de
        // readiness et ne doit jamais fermer la messagerie déjà prête.
        console.warn('[CRYPTO-MAINT] maintenance deferred:', error);
      } finally {
        _maintenancePromise = null;
      }
    })();
  }, [user, ready]);
}
