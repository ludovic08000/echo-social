import { hardCrypto } from './cryptoIntegrity';
import { bufferToBase64, base64ToBuffer } from './utils';

const TRANSFER_TTL_MS = 2 * 60 * 1000;

export interface DeviceTransferPackage {
  version: 1;
  createdAt: number;
  expiresAt: number;
  transferId: string;
  encryptedVault: string;
}

function randomHex(size = 16): string {
  const bytes = hardCrypto.getRandomValues(new Uint8Array(size));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function deriveTransferKey(secret: string): Promise<CryptoKey> {
  const material = await hardCrypto.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return hardCrypto.deriveKey(
    {
      name: 'PBKDF2',
      salt: new TextEncoder().encode('forsure-device-transfer-v1'),
      iterations: 250_000,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function createEncryptedDeviceTransferPackage(
  vaultBlob: string,
  transferSecret: string,
): Promise<DeviceTransferPackage> {
  const iv = hardCrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveTransferKey(transferSecret);

  const encrypted = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(vaultBlob),
  );

  return {
    version: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + TRANSFER_TTL_MS,
    transferId: randomHex(16),
    encryptedVault: JSON.stringify({
      iv: bufferToBase64(iv.buffer),
      ct: bufferToBase64(encrypted),
    }),
  };
}

export async function openEncryptedDeviceTransferPackage(
  transfer: DeviceTransferPackage,
  transferSecret: string,
): Promise<string> {
  if (transfer.expiresAt < Date.now()) {
    throw new Error('DEVICE_TRANSFER_EXPIRED');
  }

  const parsed = JSON.parse(transfer.encryptedVault);
  const key = await deriveTransferKey(transferSecret);

  const plain = await hardCrypto.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(parsed.iv)) },
    key,
    base64ToBuffer(parsed.ct),
  );

  return new TextDecoder().decode(plain);
}
