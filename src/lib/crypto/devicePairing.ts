import { hardCrypto } from './cryptoIntegrity';
import { bufferToBase64, base64ToBuffer } from './utils';
import { getOrCreateCurrentDeviceId, publishCurrentDevice } from './deviceList';
import { ensureSecurityEpoch, getLocalSecurityEpoch } from './securityEpoch';

const PAIRING_KEY = 'forsure-device-pairing-token:';
const PAIRING_TTL_MS = 5 * 60 * 1000;

export interface PairingPayload {
  version: 1;
  primaryDeviceId: string;
  userId: string;
  fingerprint: string;
  identityEpoch: number;
  pairingSecret: string;
  expiresAt: number;
}

export interface PairingResult {
  accepted: boolean;
  secondaryDeviceId: string;
  identityEpoch: number;
}

function storageKey(userId: string) {
  return `${PAIRING_KEY}${userId}`;
}

function randomHex(size = 32): string {
  const bytes = hardCrypto.getRandomValues(new Uint8Array(size));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function generatePairingQRCode(
  userId: string,
  fingerprint: string,
): Promise<string> {
  const payload: PairingPayload = {
    version: 1,
    primaryDeviceId: getOrCreateCurrentDeviceId(),
    userId,
    fingerprint,
    identityEpoch: getLocalSecurityEpoch(userId),
    pairingSecret: randomHex(32),
    expiresAt: Date.now() + PAIRING_TTL_MS,
  };

  // N2 (audit): do NOT persist the pairing payload — it contains `pairingSecret`
  // and nothing ever reads it back, so clear-text at rest is pure XSS exposure.
  // The secret only travels inside the QR (scanned out-of-band). Purge any copy
  // left by older builds.
  try { localStorage.removeItem(storageKey(userId)); } catch {}

  return bufferToBase64(new TextEncoder().encode(JSON.stringify(payload)).buffer);
}

export async function acceptPairingQRCode(qrPayload: string): Promise<PairingResult> {
  const decoded = JSON.parse(new TextDecoder().decode(base64ToBuffer(qrPayload))) as PairingPayload;

  if (decoded.expiresAt < Date.now()) {
    throw new Error('PAIRING_QR_EXPIRED');
  }

  const secondaryDeviceId = getOrCreateCurrentDeviceId();

  await ensureSecurityEpoch(decoded.userId, decoded.fingerprint);

  await publishCurrentDevice(
    decoded.userId,
    decoded.fingerprint,
    decoded.identityEpoch,
  );

  try {
    window.dispatchEvent(new CustomEvent('forsure-e2ee-device-linked', {
      detail: {
        userId: decoded.userId,
        primaryDeviceId: decoded.primaryDeviceId,
        secondaryDeviceId,
        identityEpoch: decoded.identityEpoch,
      },
    }));
  } catch {}

  return {
    accepted: true,
    secondaryDeviceId,
    identityEpoch: decoded.identityEpoch,
  };
}

export function revokePairingQRCode(userId: string): void {
  localStorage.removeItem(storageKey(userId));
}
