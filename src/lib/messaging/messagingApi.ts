/**
 * messagingApi — façade canonique du runtime de messagerie.
 *
 * Invariant : le runtime ne démarre qu'après APPROVED_LOCKED puis PIN_UNLOCK.
 * startRuntime rend un handle d'arrêt unique ; aucun moteur n'est démarré ailleurs.
 */

import { startRealtimeKeySync } from './realtimeKeySync';
import { startAegisDeviceInbox } from './aegisDeviceInbox';

export const messagingApi = {
  startRuntime(userId: string): () => void {
    const stopKeySync = startRealtimeKeySync({ userId });
    const stopInbox = startAegisDeviceInbox(userId);
    return () => {
      stopKeySync();
      stopInbox();
    };
  },
};
