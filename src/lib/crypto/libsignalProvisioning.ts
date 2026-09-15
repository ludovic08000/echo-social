import { supabase } from '@/integrations/supabase/client';
import { runDeviceRpcWithTimeout } from '@/lib/api/deviceRpcTimeout';
import { captureLibsignalStore, createLibsignalBundle, createLibsignalStore } from './libsignalPlatformBridge';
import { bufferToBase64 } from './utils';
import { getCurrentDeviceFinalizationTraceId, traceFinalizationOperation } from '@/lib/device-manager/deviceFinalizationTrace';

const BUNDLE_BATCH = 20;
const BUNDLE_PUBLISH_CONCURRENCY = 4;
const provisioning = new Map<string, Promise<void>>();

type RpcResult<T> = {
  data: T;
  error: { message: string } | null;
};

function randomId(): number {
  const raw = new Uint32Array(1);
  crypto.getRandomValues(raw);
  return (raw[0] & 0x7fffffff) || 1;
}

async function resolveDeviceNumber(userId: string, deviceId: string): Promise<number> {
  const { data, error } = await runDeviceRpcWithTimeout<RpcResult<number>>(
    'AEGIS_LIBSIGNAL_DEVICE_NUMBER_UNAVAILABLE',
    (signal) => (supabase as any)
      .rpc('get_libsignal_device_number', { p_user_id: userId, p_device_id: deviceId })
      .abortSignal(signal),
  );
  const value = Number(data);
  if (error || !Number.isInteger(value) || value < 1 || value > 127) throw new Error('AEGIS_LIBSIGNAL_DEVICE_NUMBER_UNAVAILABLE');
  return value;
}

async function publishBundle(args: {
  userId: string;
  deviceId: string;
  deviceNumber: number;
  traceId: string;
  attempt: number;
}): Promise<void> {
  const preKeyId = randomId();
  const signedPreKeyId = randomId();
  const kyberPreKeyId = randomId();
  const bundle = await traceFinalizationOperation('libsignal.bundle_create_and_seal',
    () => createLibsignalBundle({ ...args, preKeyId, signedPreKeyId, kyberPreKeyId }), args);
  // Le premier champ du bundle public contient les cinq u32 LE officiels.
  const metadataLength = new DataView(bundle.buffer, bundle.byteOffset, 4).getUint32(0, true);
  if (metadataLength !== 20 || bundle.byteLength < 24) throw new Error('AEGIS_LIBSIGNAL_BUNDLE_METADATA_INVALID');
  const metadata = new DataView(bundle.buffer, bundle.byteOffset + 4, 20);
  const registrationId = metadata.getUint32(0, true);
  const publicBundle = bufferToBase64(bundle.buffer.slice(bundle.byteOffset, bundle.byteOffset + bundle.byteLength) as ArrayBuffer);
  await traceFinalizationOperation('libsignal.bundle_publish', async () => {
    const result = await runDeviceRpcWithTimeout<RpcResult<{ ok?: boolean; code?: string } | null>>(
      'AEGIS_LIBSIGNAL_BUNDLE_PUBLISH_FAILED',
      (signal) => (supabase as any).rpc('publish_libsignal_prekey_bundle', {
        p_device_id: args.deviceId,
        p_device_number: args.deviceNumber,
        p_registration_id: registrationId,
        p_prekey_id: preKeyId,
        p_signed_prekey_id: signedPreKeyId,
        p_kyber_prekey_id: kyberPreKeyId,
        p_public_bundle: publicBundle,
      }).abortSignal(signal),
    );
    if (result.error || result.data?.ok !== true) throw new Error(result.data?.code ?? result.error?.message ?? 'AEGIS_LIBSIGNAL_BUNDLE_PUBLISH_FAILED');
    return result;
  }, args);
}

/** Crée puis publie un lot complet seulement après scellement de chaque privé. */
async function provisionDevice(userId: string, deviceId: string): Promise<void> {
  const context = { userId, deviceId, traceId: getCurrentDeviceFinalizationTraceId() };
  const deviceNumber = await traceFinalizationOperation('libsignal.device_number', () => resolveDeviceNumber(userId, deviceId), context);
  const { data: countData } = await traceFinalizationOperation('libsignal.bundle_count', async () => {
    const result = await runDeviceRpcWithTimeout<RpcResult<number>>(
      'AEGIS_LIBSIGNAL_BUNDLE_COUNT_FAILED',
      (signal) => (supabase as any)
        .rpc('count_libsignal_prekey_bundles', { p_device_id: deviceId })
        .abortSignal(signal),
    );
    if (result.error) throw new Error(`AEGIS_LIBSIGNAL_BUNDLE_COUNT_FAILED:${result.error.message}`);
    return result;
  }, context);
  const existing = Number(countData ?? 0);
  if (!Number.isSafeInteger(existing) || existing < 0) throw new Error('AEGIS_LIBSIGNAL_BUNDLE_COUNT_INVALID');
  // Des publics déjà publiés imposent de conserver leurs privés : ne jamais
  // recréer silencieusement une identité sous le même identifiant d'appareil.
  if (existing > 0) {
    await traceFinalizationOperation('libsignal.store_verify',
      () => captureLibsignalStore(userId, deviceId).then(() => undefined), context);
  }
  if (existing >= BUNDLE_BATCH / 2) return;
  const requestedRegistrationId = randomId();
  // La création est déjà idempotente : toute erreur de lecture/scellement doit
  // arrêter la publication, jamais être masquée par le mot « STORE ».
  await traceFinalizationOperation('libsignal.store_create_and_seal',
    () => createLibsignalStore({ userId, deviceId, registrationId: requestedRegistrationId }), context);
  const missing = BUNDLE_BATCH - existing;
  let nextBundle = 0;
  // Invariant cryptographique : chaque privé reste scellé avant publication,
  // mais les clés publiques indépendantes ne doivent plus attendre 20 RTT en série.
  const workers = Array.from(
    { length: Math.min(BUNDLE_PUBLISH_CONCURRENCY, missing) },
    async () => {
      while (nextBundle < missing) {
        const attempt = ++nextBundle;
        await publishBundle({ ...context, deviceNumber, attempt });
      }
    },
  );
  const results = await Promise.allSettled(workers);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
}

/** Les déclencheurs concurrents partagent un seul provisionnement par appareil. */
export function provisionLibsignalDevice(userId: string, deviceId: string): Promise<void> {
  const key = JSON.stringify([userId, deviceId]);
  const active = provisioning.get(key);
  if (active) return active;
  const work = provisionDevice(userId, deviceId).finally(() => {
    if (provisioning.get(key) === work) provisioning.delete(key);
  });
  provisioning.set(key, work);
  return work;
}
