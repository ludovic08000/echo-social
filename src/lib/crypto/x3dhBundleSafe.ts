import type { X3DHPrekeyBundle } from './x3dh';

export class DeviceX3DHRouteRequiredError extends Error {
  constructor(peerUserId: string) {
    super(`X3DH_DEVICE_ROUTE_REQUIRED: ${peerUserId}`);
    this.name = 'DeviceX3DHRouteRequiredError';
  }
}

/**
 * Account-wide X3DH bundles are retired.
 *
 * Callers must select an active peer device and use
 * fetchPrekeyBundleForDevice(). Returning null here would invite retry code to
 * treat the failure as transient; throwing keeps the pipeline fail-closed and
 * prevents the old 3-DH route from producing an incompatible first message.
 */
export async function fetchPrekeyBundle(peerUserId: string): Promise<X3DHPrekeyBundle | null> {
  throw new DeviceX3DHRouteRequiredError(peerUserId);
}
