/**
 * cryptoApi — façade canonique du runtime cryptographique.
 *
 * Invariant : une identité est créée au plus une fois par session
 * (verrou withEnsureLock). Aucun DeviceID n'est régénéré ici ; le cycle de vie
 * appareil (enrôlement, approbation, prekeys) reste géré par device-manager.
 */

import { withEnsureLock } from './CryptoStateMachine';
import { ensureUserE2EEIdentity } from './identityBootstrap';

export const cryptoApi = {
  /** Garantit que l'identité E2EE locale est chargée/publiée, sans rotation. */
  async ensureReady(userId: string): Promise<void> {
    await withEnsureLock(userId, async () => {
      await ensureUserE2EEIdentity(userId);
    });
  },
};
