import { supabase } from '@/integrations/supabase/client';
import { verifyRouteDeviceIdentityOffline } from './deviceLinkTrust';
import { assertExactPeerFingerprintTrusted } from './fingerprintTracker';
import { libsignalIdentityFromVerifiedBundle, verifyLibsignalBundleBinding } from './libsignalBundleBinding';
import { readDeviceVaultRecord, writeDeviceVaultRecord } from './deviceVault';
import type { LibsignalSessionOwner } from './libsignalSessionFreshness';
import type { LibsignalSessionBinding } from './libsignalSessionBinding';

export type LibsignalReceiveProof = LibsignalSessionBinding & {
  userId: string; deviceId: string; devicePublicKey: string; deviceSigningKey: string;
  deviceAuthorizationSignature: string; accountIdentityKey: string; accountSigningKey: string;
  accountFingerprint: string; accountBindingSignature: string; accountBindingVersion: number;
};
const fields = ['userId','deviceId','devicePublicKey','deviceSigningKey','deviceAuthorizationSignature',
  'accountIdentityKey','accountSigningKey','accountFingerprint','accountBindingSignature','publicBundle','signature'] as const;
const recordId = (owner: LibsignalSessionOwner) => `aegis:libsignal-receive-binding:${JSON.stringify([
  owner.ownerUserId,owner.ownerDeviceId,owner.remoteUserId,owner.remoteDeviceId,
])}`;
function valid(value: unknown): value is LibsignalReceiveProof {
  if (!value || typeof value !== 'object') return false;
  const p = value as LibsignalReceiveProof;
  return fields.every(f => typeof p[f] === 'string' && p[f].length > 0 && p[f].length <= (f === 'publicBundle' ? 262144 : 4096))
    && Number.isInteger(p.deviceNumber) && p.deviceNumber >= 1 && p.deviceNumber <= 127
    && Number.isInteger(p.registrationId) && p.registrationId > 0 && p.registrationId <= 0xffffffff
    && Number.isInteger(p.accountBindingVersion);
}

/** L'attestation historique identifie l'expéditeur ; elle n'autorise jamais
 * un nouvel envoi vers un appareil révoqué. Aucun fallback TOFU ni préclé consommée. */
export async function verifyLibsignalReceiveProof(owner: LibsignalSessionOwner, proof: LibsignalReceiveProof): Promise<Uint8Array> {
  if (!valid(proof) || proof.userId !== owner.remoteUserId || proof.deviceId !== owner.remoteDeviceId) {
    throw new Error('AEGIS_LIBSIGNAL_IDENTITY_BINDING_INVALID');
  }
  const device = await verifyRouteDeviceIdentityOffline(proof);
  if (!device) throw new Error('AEGIS_LIBSIGNAL_IDENTITY_BINDING_INVALID');
  const bundle = await verifyLibsignalBundleBinding({ userId: proof.userId, deviceId: proof.deviceId,
    deviceNumber: proof.deviceNumber, registrationId: proof.registrationId, publicBundle: proof.publicBundle },
  proof.signature, device.deviceSigningKey);
  await assertExactPeerFingerprintTrusted(owner.ownerUserId, owner.remoteUserId, device.accountFingerprint);
  return libsignalIdentityFromVerifiedBundle(bundle);
}

export async function resolveLibsignalReceiveBinding(owner: LibsignalSessionOwner): Promise<{ deviceNumber: number; identity: Uint8Array }> {
  const id = recordId(owner);
  let proof = await readDeviceVaultRecord(id, valid);
  const cached = proof !== null;
  if (!proof) {
    const { data, error } = await supabase.rpc('get_libsignal_receive_attestation' as never, {
      p_user_id: owner.remoteUserId, p_device_id: owner.remoteDeviceId,
    } as never);
    if (error) {
      const code = ['LOGIN_SECURITY_APPROVAL_REQUIRED','AEGIS_CLIENT_UPDATE_REQUIRED'].find(c => error.message.includes(c));
      throw new Error(code ?? 'AEGIS_LIBSIGNAL_RECEIVE_PROOF_UNAVAILABLE');
    }
    if (!valid(data)) throw new Error('AEGIS_LIBSIGNAL_RECEIVE_PROOF_UNAVAILABLE');
    proof = data;
  }
  const identity = await verifyLibsignalReceiveProof(owner, proof);
  if (!cached) {
    // Persister la preuve avant de consommer la préclé privée : un échec du
    // coffre laisse le message déchiffrable lors de la prochaine tentative.
    await writeDeviceVaultRecord(id, proof);
    const check = await readDeviceVaultRecord(id, valid);
    if (!check || fields.some(f => check[f] !== proof![f]) || check.deviceNumber !== proof.deviceNumber
      || check.registrationId !== proof.registrationId || check.accountBindingVersion !== proof.accountBindingVersion) {
      throw new Error('AEGIS_LIBSIGNAL_BINDING_COMMIT_FAILED');
    }
  }
  return { deviceNumber: proof.deviceNumber, identity };
}
