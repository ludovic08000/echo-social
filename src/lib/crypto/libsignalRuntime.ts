import { supabase } from '@/integrations/supabase/client';
import { libsignalIdentityFromVerifiedBundle, verifyLibsignalBundleBinding } from './libsignalBundleBinding';
import { commitLibsignalSessionBinding, readLibsignalSessionBinding, type LibsignalSessionBinding } from './libsignalSessionBinding';
import { getApprovedDeviceIdentity } from './deviceLinkTrust';
import { resolveLibsignalReceiveBinding } from './libsignalReceiveBinding';
import { assertExactPeerFingerprintTrusted } from './fingerprintTracker';
import { getLibsignalDeviceNumber } from './libsignalDeviceNumber';
import { withLibsignalSessionFreshness } from './libsignalSessionFreshness';
import { traceE2EE, traceE2EEBlock, type E2EETraceInput } from '@/lib/messaging/e2eeTrace';
import {
  decryptLibsignalMessage,
  encryptLibsignalMessage,
  establishLibsignalSession,
  type LibsignalAddress,
} from './libsignalPlatformBridge';

import { decodeLibsignalWire, encodeLibsignalWire } from './libsignalWire';
export { LIBSIGNAL_WIRE_PREFIX, decodeLibsignalWire, encodeLibsignalWire } from './libsignalWire';

type ClaimedBundle = { device_number: number; registration_id: number; public_bundle: string; bundle_signature: string };
const bundleRpc = supabase as unknown as { rpc(name: 'claim_libsignal_prekey_bundle', args: {
  p_user_id: string; p_device_id: string; p_conversation_id: string; p_sender_device_id: string;
}): PromiseLike<{ data: ClaimedBundle[] | ClaimedBundle | null; error: { message: string } | null }> };

async function addresses(localUserId: string, localDeviceId: string, remoteUserId: string, remoteDeviceId: string): Promise<{ local: LibsignalAddress; remote: LibsignalAddress }> {
  const [localNumber, remoteNumber] = await Promise.all([
    traceE2EEBlock({ direction: 'session', component: 'libsignal', stage: 'LOCAL_DEVICE_NUMBER', deviceId: localDeviceId }, () => getLibsignalDeviceNumber(localUserId, localDeviceId)),
    traceE2EEBlock({ direction: 'session', component: 'libsignal', stage: 'REMOTE_DEVICE_NUMBER', peerDeviceId: remoteDeviceId }, () => getLibsignalDeviceNumber(remoteUserId, remoteDeviceId)),
  ]);
  return { local: { userId: localUserId, deviceNumber: localNumber }, remote: { userId: remoteUserId, deviceNumber: remoteNumber } };
}

export async function encryptForLibsignalDevice(args: { conversationId: string; ownerUserId: string; ownerDeviceId: string; remoteUserId: string; remoteDeviceId: string; plaintext: string }): Promise<string> {
  const context: E2EETraceInput = { direction: 'send', component: 'libsignal', stage: 'SESSION',
    conversationId: args.conversationId, deviceId: args.ownerDeviceId, peerDeviceId: args.remoteDeviceId };
  return withLibsignalSessionFreshness(args, async (renew, established) => {
    traceE2EE({ ...context, stage: renew ? 'SESSION_RENEW_REQUIRED' : 'SESSION_REUSE_ATTEMPT', outcome: 'start' });
    const [route, device, cachedProof] = await Promise.all([
      addresses(args.ownerUserId, args.ownerDeviceId, args.remoteUserId, args.remoteDeviceId),
      getApprovedDeviceIdentity(args.remoteUserId, args.remoteDeviceId),
      readLibsignalSessionBinding(args),
    ]);
    await assertExactPeerFingerprintTrusted(args.ownerUserId, args.remoteUserId, device.accountFingerprint);
    const verify = async (proof: LibsignalSessionBinding) => {
      if (proof.deviceNumber !== route.remote.deviceNumber) throw new Error('AEGIS_LIBSIGNAL_BUNDLE_BINDING_INVALID');
      return verifyLibsignalBundleBinding({ userId: args.remoteUserId, deviceId: args.remoteDeviceId,
        deviceNumber: proof.deviceNumber, registrationId: proof.registrationId, publicBundle: proof.publicBundle },
      proof.signature, device.deviceSigningKey);
    };
    const claim = () => traceE2EEBlock({ ...context, stage: 'CLAIM_REMOTE_PREKEY_BUNDLE', transport: 'supabase' }, async (): Promise<LibsignalSessionBinding> => {
      const { data, error } = await bundleRpc.rpc('claim_libsignal_prekey_bundle', {
        p_user_id: args.remoteUserId, p_device_id: args.remoteDeviceId,
        p_conversation_id: args.conversationId, p_sender_device_id: args.ownerDeviceId,
      });
      if (error) {
        const code = ['AEGIS_CLIENT_UPDATE_REQUIRED', 'AEGIS_LIBSIGNAL_PREKEY_RATE_LIMITED',
          'LOGIN_SECURITY_APPROVAL_REQUIRED', 'AEGIS_PEER_DEVICE_UPDATE_REQUIRED'].find((value) => error.message.includes(value));
        throw new Error(code ?? 'AEGIS_LIBSIGNAL_PREKEY_BUNDLE_UNAVAILABLE');
      }
      const bundle = Array.isArray(data) ? data[0] : data;
      if (!bundle?.public_bundle || (Array.isArray(data) && data.length !== 1)) throw new Error('AEGIS_LIBSIGNAL_PREKEY_BUNDLE_UNAVAILABLE');
      return { deviceNumber: bundle.device_number, registrationId: Number(bundle.registration_id),
        publicBundle: bundle.public_bundle, signature: bundle.bundle_signature };
    });
    let proof = cachedProof;
    // Même une session existante exige une preuve liée à l'appareil approuvé.
    // En migration, on contrôle le ratchet existant sans le recréer ni effacer ses clés.
    let boundBundle = proof ? await verify(proof) : null;
    let claimed = renew || !proof;
    if (claimed) {
      proof = await claim();
      boundBundle = await verify(proof);
    }
    const attempt = () => traceE2EEBlock({ ...context, stage: 'LIBSIGNAL_ENCRYPT' }, () => encryptLibsignalMessage({
      ownerUserId: args.ownerUserId, ownerDeviceId: args.ownerDeviceId, ...route,
      verifiedRemoteIdentity: libsignalIdentityFromVerifiedBundle(boundBundle!), plaintext: new TextEncoder().encode(args.plaintext),
    }));
    const finish = async (encrypted: Awaited<ReturnType<typeof encryptLibsignalMessage>>) => {
      if (claimed) await commitLibsignalSessionBinding(args, proof!);
      return encodeLibsignalWire(encrypted.messageType, encrypted.ciphertext);
    };
    if (!renew) {
      try {
        const encrypted = await attempt();
        return await finish(encrypted);
      } catch (error) {
        // Seule l'absence de session autorise un bootstrap, jamais une erreur de confiance ou de coffre.
        const message = error instanceof Error ? error.message : String(error);
        if (!/\bSessionNotFound\b|\bsession(?: with [^\r\n]+)? not found(?:\b|:)/.test(message)) throw error;
        traceE2EE({ ...context, stage: 'SESSION_MISSING_BOOTSTRAP', outcome: 'retry', errorCode: 'SessionNotFound' });
      }
    }
    if (!claimed) {
      proof = await claim();
      boundBundle = await verify(proof);
      claimed = true;
    }
    // La signature Aegis autorise l'identité du bundle ; Libsignal conserve ses
    // propres contrôles PQXDH, de signature et de confiance avant tout ratchet.
    await traceE2EEBlock({ ...context, stage: 'LIBSIGNAL_ESTABLISH_SESSION' }, () => establishLibsignalSession({ ownerUserId: args.ownerUserId, ownerDeviceId: args.ownerDeviceId, ...route, bundle: boundBundle! }));
    await traceE2EEBlock({ ...context, stage: 'SESSION_FRESHNESS_COMMIT' }, established);
    const encrypted = await attempt();
    return finish(encrypted);
  });
}

export async function decryptFromLibsignalDevice(args: { ownerUserId: string; ownerDeviceId: string; remoteUserId: string; remoteDeviceId: string; payload: string }): Promise<string | null> {
  const encrypted = decodeLibsignalWire(args.payload);
  if (!encrypted) return null;
  const [localNumber, binding] = await Promise.all([
    getLibsignalDeviceNumber(args.ownerUserId, args.ownerDeviceId),
    resolveLibsignalReceiveBinding(args),
  ]);
  // La route distante vient de l'attestation signée persistante, pas de l'état
  // actif actuel : les messages retardés d'un ancien appareil restent lisibles.
  const route = { local: { userId: args.ownerUserId, deviceNumber: localNumber },
    remote: { userId: args.remoteUserId, deviceNumber: binding.deviceNumber } };
  const plaintext = await traceE2EEBlock({ direction: 'receive', component: 'libsignal', stage: 'LIBSIGNAL_DECRYPT',
    deviceId: args.ownerDeviceId, peerDeviceId: args.remoteDeviceId }, () => decryptLibsignalMessage({ ownerUserId: args.ownerUserId, ownerDeviceId: args.ownerDeviceId, ...route, verifiedRemoteIdentity: binding.identity, encrypted }));
  return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
}
