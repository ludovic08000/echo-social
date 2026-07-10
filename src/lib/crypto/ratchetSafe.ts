import { bufferToBase64 } from './utils';
import { exportPublicKeyRaw } from './keyManager';
import {
  ratchetDecrypt as decryptCore,
  type RatchetEnvelope,
  type RatchetState,
} from './ratchet';

async function assertNotExpiredReplay(state: RatchetState, envelope: RatchetEnvelope): Promise<void> {
  if (!state.dhReceivingKey) return;
  const currentDh = bufferToBase64(await exportPublicKeyRaw(state.dhReceivingKey));
  if (currentDh !== envelope.hdr.dh) return;

  const skippedId = `${envelope.hdr.dh}:${envelope.hdr.n}`;
  if (envelope.hdr.n < state.recvCount && !state.skippedKeys.has(skippedId)) {
    throw new Error('RATCHET_REPLAY_OR_EXPIRED_MESSAGE');
  }
}

/**
 * Fail-closed facade for all application-level ratchet decryption.
 *
 * Version 4 has always been emitted with bucket padding. Rejecting a missing or
 * modified padding flag prevents an attacker from turning an authenticated
 * padded plaintext into a raw string with attacker-controlled trailing bytes.
 */
export async function ratchetDecrypt(
  state: RatchetState,
  envelope: RatchetEnvelope,
  peerSigningKeyBase64?: string,
): Promise<{ plaintext: string; verified: boolean; newState: RatchetState }> {
  if (envelope.v === 4 && envelope.pad !== 1) {
    throw new Error('RATCHET_V4_PADDING_REQUIRED');
  }

  await assertNotExpiredReplay(state, envelope);
  return decryptCore(state, envelope, peerSigningKeyBase64);
}
