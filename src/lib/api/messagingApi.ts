/**
 * messagingApi — façade canonique du runtime de messagerie.
 *
 * Invariant : le runtime ne démarre qu'après APPROVED_LOCKED puis PIN_UNLOCK.
 * startRuntime rend un handle unique { stop } ; aucun moteur n'est démarré ailleurs.
 */

import { startRealtimeKeySync } from '@/lib/messaging/realtimeKeySync';
import { startAegisDeviceInbox } from '@/lib/messaging/aegisDeviceInbox';

export interface MessagingRuntimeHandle {
  stop: () => void;
}

export const messagingApi = {
  async startRuntime(userId: string): Promise<MessagingRuntimeHandle> {
    const stopKeySync = startRealtimeKeySync({ userId });
    const stopInbox = startAegisDeviceInbox(userId);
    let stopped = false;
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        stopKeySync();
        stopInbox();
      },
    };
  },
};
