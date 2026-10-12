import { readDeviceVaultRecord, writeDeviceVaultRecord } from './deviceVault';
import type { LibsignalSessionOwner } from './libsignalSessionFreshness';

export type LibsignalSessionBinding = {
  deviceNumber: number;
  registrationId: number;
  publicBundle: string;
  signature: string;
};

const recordId = (owner: LibsignalSessionOwner) => `aegis:libsignal-binding:${JSON.stringify([
  owner.ownerUserId, owner.ownerDeviceId, owner.remoteUserId, owner.remoteDeviceId,
])}`;
const valid = (value: unknown): value is LibsignalSessionBinding => {
  if (!value || typeof value !== 'object') return false;
  const proof = value as LibsignalSessionBinding;
  return Number.isInteger(proof.deviceNumber) && proof.deviceNumber > 0 && proof.deviceNumber <= 127
    && Number.isInteger(proof.registrationId) && proof.registrationId > 0 && proof.registrationId <= 0xffffffff
    && typeof proof.publicBundle === 'string' && proof.publicBundle.length > 0 && proof.publicBundle.length <= 262144
    && typeof proof.signature === 'string' && proof.signature.length === 88;
};

// Une preuve publique persistante évite de consommer une préclé à chaque envoi.
// Sa signature et l'approbation actuelle de l'appareil sont revérifiées à l'usage.
export function readLibsignalSessionBinding(owner: LibsignalSessionOwner): Promise<LibsignalSessionBinding | null> {
  return readDeviceVaultRecord(recordId(owner), valid);
}

export async function commitLibsignalSessionBinding(owner: LibsignalSessionOwner, proof: LibsignalSessionBinding): Promise<void> {
  if (!valid(proof)) throw new Error('AEGIS_LIBSIGNAL_BUNDLE_BINDING_INVALID');
  await writeDeviceVaultRecord(recordId(owner), proof);
  const check = await readLibsignalSessionBinding(owner);
  if (!check || check.deviceNumber !== proof.deviceNumber || check.registrationId !== proof.registrationId
    || check.publicBundle !== proof.publicBundle || check.signature !== proof.signature) {
    throw new Error('AEGIS_LIBSIGNAL_BINDING_COMMIT_FAILED');
  }
}
