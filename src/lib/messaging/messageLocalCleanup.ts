import { clearMediaKey } from '@/components/messages/mediaKeyCache';
import { forgetDecryptedMediaByUrl } from '@/components/messages/decryptedMediaCache';
import { purgeDecryptionStateForMessage } from '@/components/messages/decryptionService';
import {
  removePlaintext,
  removePlaintextForCiphertext,
} from '@/lib/crypto/plaintextStore';
import { clearDeviceCopyCacheForMessage } from '@/lib/messaging/multiDeviceFanout';

export interface MessageLocalCleanupInput {
  messageId: string;
  body?: string | null;
  imageUrl?: string | null;
}

/**
 * Removes every client-side representation that can make a deleted or consumed
 * message readable again. Server deletion remains authoritative; this function
 * only performs local cryptographic erasure and is safe to call repeatedly.
 */
export async function purgeMessageLocalState(input: MessageLocalCleanupInput): Promise<void> {
  if (!input.messageId) return;
  clearMediaKey(input.messageId);
  clearDeviceCopyCacheForMessage(input.messageId);
  purgeDecryptionStateForMessage(input.messageId, input.body ?? undefined);
  if (input.imageUrl) forgetDecryptedMediaByUrl(input.imageUrl);

  const removals: Promise<unknown>[] = [
    removePlaintext(input.messageId),
    removePlaintext(`aegis-capsule:${input.messageId}`),
  ];
  if (input.body) removals.push(removePlaintextForCiphertext(input.body));
  await Promise.allSettled(removals);
}
