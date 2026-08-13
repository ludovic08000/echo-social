import { supabase } from '@/integrations/supabase/client';
import { createLibsignalBundle, createLibsignalStore } from './aegisWasmBridge';
import { bufferToBase64 } from './utils';

const BUNDLE_BATCH = 20;

function randomId(): number {
  const raw = new Uint32Array(1);
  crypto.getRandomValues(raw);
  return (raw[0] & 0x7fffffff) || 1;
}

async function resolveDeviceNumber(userId: string, deviceId: string): Promise<number> {
  const { data, error } = await (supabase as any).rpc('get_libsignal_device_number', { p_user_id: userId, p_device_id: deviceId });
  const value = Number(data);
  if (error || !Number.isInteger(value) || value < 1 || value > 127) throw new Error('AEGIS_LIBSIGNAL_DEVICE_NUMBER_UNAVAILABLE');
  return value;
}

/** Crée puis publie un lot complet seulement après scellement de chaque privé. */
export async function provisionLibsignalDevice(userId: string, deviceId: string): Promise<void> {
  const deviceNumber = await resolveDeviceNumber(userId, deviceId);
  const { data: countData, error: countError } = await (supabase as any).rpc(
    'count_libsignal_prekey_bundles', { p_device_id: deviceId },
  );
  if (countError) throw new Error(`AEGIS_LIBSIGNAL_BUNDLE_COUNT_FAILED:${countError.message}`);
  const existing = Number(countData ?? 0);
  if (existing >= BUNDLE_BATCH / 2) return;
  const requestedRegistrationId = randomId();
  try {
    await createLibsignalStore({ userId, deviceId, registrationId: requestedRegistrationId });
  } catch (error) {
    if (!String(error).includes('STORE')) throw error;
  }
  for (let index = existing; index < BUNDLE_BATCH; index += 1) {
    const preKeyId = randomId();
    const signedPreKeyId = randomId();
    const kyberPreKeyId = randomId();
    const bundle = await createLibsignalBundle({ userId, deviceId, deviceNumber, preKeyId, signedPreKeyId, kyberPreKeyId });
    // Le premier champ du bundle public contient les cinq u32 LE officiels.
    const metadataLength = new DataView(bundle.buffer, bundle.byteOffset, 4).getUint32(0, true);
    if (metadataLength !== 20 || bundle.byteLength < 24) throw new Error('AEGIS_LIBSIGNAL_BUNDLE_METADATA_INVALID');
    const metadata = new DataView(bundle.buffer, bundle.byteOffset + 4, 20);
    const registrationId = metadata.getUint32(0, true);
    const publicBundle = bufferToBase64(bundle.buffer.slice(bundle.byteOffset, bundle.byteOffset + bundle.byteLength) as ArrayBuffer);
    const { data, error } = await (supabase as any).rpc('publish_libsignal_prekey_bundle', {
      p_device_id: deviceId,
      p_device_number: deviceNumber,
      p_registration_id: registrationId,
      p_prekey_id: preKeyId,
      p_signed_prekey_id: signedPreKeyId,
      p_kyber_prekey_id: kyberPreKeyId,
      p_public_bundle: publicBundle,
    });
    if (error || data?.ok !== true) throw new Error(data?.code ?? error?.message ?? 'AEGIS_LIBSIGNAL_BUNDLE_PUBLISH_FAILED');
  }
}
