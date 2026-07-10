import { supabase } from '@/integrations/supabase/client';
import {
  fetchPrekeyBundle as fetchLegacyAccountBundle,
  type X3DHPrekeyBundle,
} from './x3dh';

export class DeviceX3DHRouteRequiredError extends Error {
  constructor(peerUserId: string) {
    super(`X3DH_DEVICE_ROUTE_REQUIRED: ${peerUserId}`);
    this.name = 'DeviceX3DHRouteRequiredError';
  }
}

/**
 * Legacy account-wide X3DH is only valid for accounts that have never published
 * an active device route. Once device records exist, a failed device lookup is
 * a hard failure rather than permission to silently downgrade to account 3-DH.
 */
export async function fetchPrekeyBundle(peerUserId: string): Promise<X3DHPrekeyBundle | null> {
  const { data, error } = await supabase
    .from('user_devices' as any)
    .select('device_id')
    .eq('user_id', peerUserId)
    .is('revoked_at', null)
    .limit(1);

  if (error) {
    throw new Error(`X3DH_DEVICE_ROUTE_CHECK_FAILED: ${error.message}`);
  }

  if (Array.isArray(data) && data.length > 0) {
    throw new DeviceX3DHRouteRequiredError(peerUserId);
  }

  return fetchLegacyAccountBundle(peerUserId);
}
