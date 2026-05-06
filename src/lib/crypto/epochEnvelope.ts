import { attachEpochToEnvelope, getLocalSecurityEpoch, isEnvelopeEpochStale } from './securityEpoch';
import { createSealedSenderEnvelope } from './sealedSender';
import type { SenderCertificate } from './senderCertificate';

export interface EpochBoundEnvelope<T = Record<string, unknown>> {
  identityEpoch: number;
  senderCertificate?: SenderCertificate | null;
  sealedSender?: ReturnType<typeof createSealedSenderEnvelope>;
  payload: T;
}

export function createEpochBoundEnvelope<T extends Record<string, unknown>>(
  userId: string,
  payload: T,
  senderCertificate?: SenderCertificate | null,
): EpochBoundEnvelope<T> {
  const withEpoch = attachEpochToEnvelope(payload, userId);

  return {
    identityEpoch: getLocalSecurityEpoch(userId),
    senderCertificate: senderCertificate || null,
    sealedSender: createSealedSenderEnvelope(),
    payload: withEpoch,
  };
}

export function assertEnvelopeEpochValid(userId: string, envelope: EpochBoundEnvelope<any>): void {
  if (isEnvelopeEpochStale(userId, envelope.identityEpoch)) {
    throw new Error('STALE_IDENTITY_EPOCH');
  }
}
