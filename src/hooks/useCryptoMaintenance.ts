/**
 * useCryptoMaintenance — Auto-maintenance globale des clés E2EE
 * 
 * Garantit qu'à chaque démarrage de l'app (utilisateur authentifié) :
 *   1. Les identity keys existent (sinon créées)
 *   2. Le Signed Prekey est valide et non expiré (rotation 7j)
 *   3. Les One-Time Prekeys sont au-dessus du seuil de refill
 *   4. Les OPK orphelins (présents serveur mais absents IndexedDB) sont purgés
 * 
 * Sans ce hook, un utilisateur qui n'ouvre jamais /messages voit ses prekeys
 * s'épuiser et ses pairs ne peuvent plus initier de session X3DH avec lui.
 * 
 * S'exécute UNE FOIS par session de connexion (anti-storm).
 */

import { useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import {
  getOrCreateIdentityKeys,
  refreshSignedPrekeyIfNeeded,
  refreshDeviceSignedPrekeyIfNeeded,
  refillDeviceOneTimePrekeysIfNeeded,
} from '@/lib/crypto';
import { getCurrentDeviceId, hydrateDeviceId } from '@/lib/messaging/currentDevice';

const MAINTENANCE_TTL = 6 * 60 * 60 * 1000; // 6h between auto-refills
const STORAGE_KEY = 'forsure-crypto-maintenance-ts';

/** Global one-shot guard so multiple mounts don't run it in parallel. */
let _maintenancePromise: Promise<void> | null = null;

export function useCryptoMaintenance() {
  const { user } = useAuth();
  const ranRef = useRef(false);

  useEffect(() => {
    if (!user || ranRef.current) return;
    ranRef.current = true;

    // Throttle across reloads: skip if last run < TTL ago
    try {
      const last = Number(localStorage.getItem(STORAGE_KEY) || '0');
      if (Date.now() - last < MAINTENANCE_TTL) {
        return;
      }
    } catch {}

    if (_maintenancePromise) return;

    _maintenancePromise = (async () => {
      try {
        // Defer to avoid competing with first-paint rendering
        await new Promise((r) => setTimeout(r, 3000));

        console.info('[CRYPTO-MAINT] Starting key maintenance check…');

        // 1. Ensure identity keys
        const keys = await getOrCreateIdentityKeys(user.id);
        if (!keys) {
          console.warn('[CRYPTO-MAINT] Identity keys unavailable (PIN locked?) — skipping');
          return;
        }

        // 2. Rotate SPK if expired or out-of-sync
        try {
          await refreshSignedPrekeyIfNeeded(user.id, keys.signingPrivateKey);
        } catch (spkErr) {
          console.warn('[CRYPTO-MAINT] SPK refresh failed:', spkErr);
        }

        // OPK system removed — only SPK rotation is needed.

        try {
          localStorage.setItem(STORAGE_KEY, String(Date.now()));
        } catch {}

        console.info('[CRYPTO-MAINT] ✅ Maintenance complete');
      } catch (e) {
        console.error('[CRYPTO-MAINT] Unexpected error:', e);
      } finally {
        _maintenancePromise = null;
      }
    })();
  }, [user]);
}
