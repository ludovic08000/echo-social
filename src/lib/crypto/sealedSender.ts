import { hardCrypto } from './cryptoIntegrity';
import { bufferToBase64 } from './utils';

export interface SealedSenderEnvelope {
  anonymousSenderTag: string;
  sealedAt: number;
}

const TAG_BYTES = 32;

export function createAnonymousSenderTag(): string {
  const bytes = hardCrypto.getRandomValues(new Uint8Array(TAG_BYTES));
  return bufferToBase64(bytes.buffer);
}

export function createSealedSenderEnvelope(): SealedSenderEnvelope {
  return {
    anonymousSenderTag: createAnonymousSenderTag(),
    sealedAt: Date.now(),
  };
}
