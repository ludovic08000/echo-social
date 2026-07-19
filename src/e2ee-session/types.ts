/** Minimal Sesame-lite device-routing types. */

export type DeviceId = string;
export type UserId = string;

export interface DeviceDescriptor {
  userId: UserId;
  deviceId: DeviceId;
  /** Published per-device public key (X25519 raw, base64). */
  devicePublicKey: string;
  /** Last successful exchange with this device, in epoch milliseconds. */
  lastSeen?: number;
}
