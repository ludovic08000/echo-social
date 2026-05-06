import { supabase } from '@/integrations/supabase/client';
import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { bufferToBase64 } from './utils';
import { loadIdentityKeys } from './keyManager';
import { fetchActiveDevices, type DeviceListEntry } from './deviceList';

export interface SignedDeviceManifest {
  version: 1;
  userId: string;
  devices: DeviceListEntry[];
  signedAt: number;
  signature: string;
}

async function signManifestPayload(userId: string, payload: Omit<SignedDeviceManifest, 'signature'>): Promise<string> {
  const keys = await loadIdentityKeys(userId);
  if (!keys) throw new Error('NO_IDENTITY_FOR_DEVICE_MANIFEST');

  const bytes = new hardGlobals.TextEncoder().encode(JSON.stringify(payload));
  const sig = await hardCrypto.sign('Ed25519' as any, keys.signingPrivateKey, bytes);
  return bufferToBase64(sig);
}

export async function publishSignedDeviceManifest(userId: string): Promise<SignedDeviceManifest | null> {
  const devices = await fetchActiveDevices(userId);
  if (!devices.length) return null;

  const payload = {
    version: 1 as const,
    userId,
    devices,
    signedAt: Date.now(),
  };

  const manifest: SignedDeviceManifest = {
    ...payload,
    signature: await signManifestPayload(userId, payload),
  };

  try {
    await supabase
      .from('user_device_manifests' as any)
      .upsert({
        user_id: userId,
        payload: JSON.stringify(payload),
        signature: manifest.signature,
        signed_at: new Date(manifest.signedAt).toISOString(),
      }, { onConflict: 'user_id' });
  } catch (error) {
    console.warn('[E2EE][DEVICE] manifest publish skipped', error);
  }

  return manifest;
}

export async function fetchSignedDeviceManifest(userId: string): Promise<SignedDeviceManifest | null> {
  const { data } = await supabase
    .from('user_device_manifests' as any)
    .select('payload, signature, signed_at')
    .eq('user_id', userId)
    .maybeSingle();

  const row = data as any;
  if (!row?.payload || !row?.signature) return null;

  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  return {
    ...payload,
    signature: row.signature,
  } as SignedDeviceManifest;
}
