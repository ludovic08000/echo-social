import { supabase } from '@/integrations/supabase/client';
import { base64ToBuffer } from './utils';
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

async function deviceNumber(userId: string, deviceId: string): Promise<number> {
  const { data, error } = await (supabase as any).rpc('get_libsignal_device_number', { p_user_id: userId, p_device_id: deviceId });
  const number = Number(data);
  if (error || !Number.isInteger(number) || number < 1 || number > 127) throw new Error('AEGIS_LIBSIGNAL_DEVICE_NUMBER_UNAVAILABLE');
  return number;
}

async function addresses(localUserId: string, localDeviceId: string, remoteUserId: string, remoteDeviceId: string): Promise<{ local: LibsignalAddress; remote: LibsignalAddress }> {
  const [localNumber, remoteNumber] = await Promise.all([
    traceE2EEBlock({ direction: 'session', component: 'libsignal', stage: 'LOCAL_DEVICE_NUMBER', deviceId: localDeviceId }, () => deviceNumber(localUserId, localDeviceId)),
    traceE2EEBlock({ direction: 'session', component: 'libsignal', stage: 'REMOTE_DEVICE_NUMBER', peerDeviceId: remoteDeviceId }, () => deviceNumber(remoteUserId, remoteDeviceId)),
  ]);
  return { local: { userId: localUserId, deviceNumber: localNumber }, remote: { userId: remoteUserId, deviceNumber: remoteNumber } };
}

export async function encryptForLibsignalDevice(args: { conversationId: string; ownerUserId: string; ownerDeviceId: string; remoteUserId: string; remoteDeviceId: string; plaintext: string }): Promise<string> {
  const context: E2EETraceInput = { direction: 'send', component: 'libsignal', stage: 'SESSION',
    conversationId: args.conversationId, deviceId: args.ownerDeviceId, peerDeviceId: args.remoteDeviceId };
  return withLibsignalSessionFreshness(args, async (renew, established) => {
    traceE2EE({ ...context, stage: renew ? 'SESSION_RENEW_REQUIRED' : 'SESSION_REUSE_ATTEMPT', outcome: 'start' });
    const route = await addresses(args.ownerUserId, args.ownerDeviceId, args.remoteUserId, args.remoteDeviceId);
    const attempt = () => traceE2EEBlock({ ...context, stage: 'LIBSIGNAL_ENCRYPT' }, () => encryptLibsignalMessage({ ownerUserId: args.ownerUserId, ownerDeviceId: args.ownerDeviceId, ...route, plaintext: new TextEncoder().encode(args.plaintext) }));
    if (!renew) {
      try {
        const encrypted = await attempt();
        return encodeLibsignalWire(encrypted.messageType, encrypted.ciphertext);
      } catch (error) {
        // Seule l'absence de session autorise un bootstrap, jamais une erreur de confiance ou de coffre.
        const message = error instanceof Error ? error.message : String(error);
        if (!/\bSessionNotFound\b|\bsession(?: with [^\r\n]+)? not found(?:\b|:)/.test(message)) throw error;
        traceE2EE({ ...context, stage: 'SESSION_MISSING_BOOTSTRAP', outcome: 'retry', errorCode: 'SessionNotFound' });
      }
    }
    const row = await traceE2EEBlock({ ...context, stage: 'CLAIM_REMOTE_PREKEY_BUNDLE', transport: 'supabase' }, async () => {
      const { data, error } = await (supabase as any).rpc('claim_libsignal_prekey_bundle', {
        p_user_id: args.remoteUserId,
        p_device_id: args.remoteDeviceId,
        p_conversation_id: args.conversationId,
        p_sender_device_id: args.ownerDeviceId,
      });
      const bundle = Array.isArray(data) ? data[0] : data;
      if (error || !bundle?.public_bundle) throw new Error('AEGIS_LIBSIGNAL_PREKEY_BUNDLE_UNAVAILABLE');
      return bundle;
    });
    // Libsignal effectue lui-même ses contrôles de signature/confiance : pas de succès inventé à partir de la présence du bundle.
    await traceE2EEBlock({ ...context, stage: 'LIBSIGNAL_ESTABLISH_SESSION' }, () => establishLibsignalSession({ ownerUserId: args.ownerUserId, ownerDeviceId: args.ownerDeviceId, ...route, bundle: new Uint8Array(base64ToBuffer(row.public_bundle)) }));
    await traceE2EEBlock({ ...context, stage: 'SESSION_FRESHNESS_COMMIT' }, established);
    const encrypted = await attempt();
    return encodeLibsignalWire(encrypted.messageType, encrypted.ciphertext);
  });
}

export async function decryptFromLibsignalDevice(args: { ownerUserId: string; ownerDeviceId: string; remoteUserId: string; remoteDeviceId: string; payload: string }): Promise<string | null> {
  const encrypted = decodeLibsignalWire(args.payload);
  if (!encrypted) return null;
  const route = await addresses(args.ownerUserId, args.ownerDeviceId, args.remoteUserId, args.remoteDeviceId);
  const plaintext = await traceE2EEBlock({ direction: 'receive', component: 'libsignal', stage: 'LIBSIGNAL_DECRYPT',
    deviceId: args.ownerDeviceId, peerDeviceId: args.remoteDeviceId }, () => decryptLibsignalMessage({ ownerUserId: args.ownerUserId, ownerDeviceId: args.ownerDeviceId, ...route, encrypted }));
  return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
}
