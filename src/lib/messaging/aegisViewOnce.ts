import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { getCachedAuthUserId } from '@/lib/crypto/peerKeyCache';
import { tryDecryptDeviceTargetedBody } from '@/lib/messaging/multiDeviceFanout';
import { openAegisMessage, parseAegisMessageEnvelope } from '@/lib/messaging/aegisEnvelope';
import { parseMediaMessage, importMediaKey, decryptMediaWithMetadata, isVideoMediaLabel } from '@/lib/crypto/mediaEncrypt';
import { fetchR2Object } from '@/lib/r2';
import { readResponseArrayBufferBounded } from '@/lib/messaging/boundedResponse';
import { MAX_INCOMING_ATTACHMENT_CIPHERTEXT_BYTES } from '@/lib/messaging/attachmentLimits';
import { supabase } from '@/integrations/supabase/client';
import { purgeMessageLocalState } from '@/lib/messaging/messageLocalCleanup';
import {
  parseViewOnceBeginState,
  parseViewOnceClaimReceipt,
  parseViewOnceCommitReceipt,
} from '@/lib/messaging/aegisViewOnceProtocol';

export type OpenViewOnceResult =
  | { status: 'opened'; blob: Blob; isVideo: boolean; label: string }
  | { status: 'consumed' | 'claimed_elsewhere' | 'not_found' | 'sender' }
  | { status: 'error'; reason: string };

type RpcResult = { data: unknown; error: { message?: string | null; code?: string | null } | null };

interface PendingOpenedViewOnce {
  blob: Blob;
  isVideo: boolean;
  label: string;
  deviceId: string;
  claimToken: string;
  parentBody: string;
  imageUrl: string;
}

const COMMIT_ATTEMPTS = 3;
const COMMIT_RETRY_MS = 250;
const pendingOpened = new Map<string, PendingOpenedViewOnce>();
const channel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('aegis-view-once-v1')
  : null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpc(name: string, args: Record<string, unknown>): Promise<RpcResult> {
  const invoke = supabase.rpc as unknown as (
    functionName: string,
    functionArgs: Record<string, unknown>,
  ) => PromiseLike<RpcResult>;
  return invoke(name, args);
}

async function releaseClaim(messageId: string, deviceId: string, claimToken: string): Promise<void> {
  await rpc('release_aegis_view_once_claim', {
    p_message_id: messageId,
    p_device_id: deviceId,
    p_claim_token: claimToken,
  }).catch(() => undefined);
}

async function commitConsumption(messageId: string, deviceId: string, claimToken: string): Promise<boolean> {
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt += 1) {
    const response = await rpc('commit_aegis_view_once_consume', {
      p_message_id: messageId,
      p_device_id: deviceId,
      p_claim_token: claimToken,
    }).catch((error) => ({
      data: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    }));
    const receipt = parseViewOnceCommitReceipt(response.data);
    if (receipt && receipt.messageId === messageId && receipt.claimToken === claimToken) return true;
    if (response.error && attempt + 1 < COMMIT_ATTEMPTS) {
      await sleep(COMMIT_RETRY_MS * (attempt + 1));
    }
  }
  return false;
}

async function finalizePending(
  messageId: string,
  pending: PendingOpenedViewOnce,
): Promise<OpenViewOnceResult> {
  const committed = await commitConsumption(messageId, pending.deviceId, pending.claimToken);
  if (!committed) return { status: 'error', reason: 'VIEW_ONCE_COMMIT_UNCONFIRMED' };

  pendingOpened.delete(messageId);
  await purgeMessageLocalState({
    messageId,
    body: pending.parentBody,
    imageUrl: pending.imageUrl,
  });
  channel?.postMessage({ type: 'consumed', messageId });
  return {
    status: 'opened',
    blob: pending.blob,
    isVideo: pending.isVideo,
    label: pending.label,
  };
}

/**
 * Opens one view-once media item without touching the normal plaintext, archive,
 * media-key or decrypted-blob caches.
 *
 * The encrypted R2 object is downloaded before the device copy is decrypted, so
 * a transient network failure cannot advance the Double Ratchet and strand the
 * only readable capsule. If the authoritative commit is temporarily ambiguous,
 * the decrypted blob remains only in RAM and a second click retries that commit
 * without replaying the Ratchet message.
 */
export async function openAegisViewOnce(messageId: string): Promise<OpenViewOnceResult> {
  const userId = await getCachedAuthUserId().catch(() => null);
  const deviceId = getCurrentDeviceId();
  if (!userId || isDeviceIdTemporary() || !messageId) {
    return { status: 'error', reason: 'VIEW_ONCE_DEVICE_NOT_READY' };
  }

  const pending = pendingOpened.get(messageId);
  if (pending) {
    if (pending.deviceId !== deviceId) {
      return { status: 'error', reason: 'VIEW_ONCE_PENDING_ON_ANOTHER_DEVICE' };
    }
    return finalizePending(messageId, pending);
  }

  const begin = await rpc('begin_aegis_view_once_consume', {
    p_message_id: messageId,
    p_device_id: deviceId,
  }).catch((error) => ({
    data: null,
    error: { message: error instanceof Error ? error.message : String(error) },
  }));
  if (begin.error) return { status: 'error', reason: begin.error.message ?? 'VIEW_ONCE_BEGIN_FAILED' };

  const state = parseViewOnceBeginState(begin.data);
  if (state && state !== 'claimed') return { status: state };
  const claim = parseViewOnceClaimReceipt(begin.data);
  if (!claim || claim.messageId !== messageId) {
    return { status: 'error', reason: 'VIEW_ONCE_CLAIM_RECEIPT_INVALID' };
  }

  let encryptedMedia: ArrayBuffer;
  try {
    const response = await fetchR2Object(claim.imageUrl);
    if (!response.ok) throw new Error(`VIEW_ONCE_MEDIA_FETCH_${response.status}`);
    encryptedMedia = await readResponseArrayBufferBounded(
      response,
      MAX_INCOMING_ATTACHMENT_CIPHERTEXT_BYTES,
    );
  } catch (error) {
    await releaseClaim(messageId, deviceId, claim.claimToken);
    return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
  }

  try {
    const capsule = await tryDecryptDeviceTargetedBody({
      encrypted_body: claim.encryptedBody,
      sender_user_id: claim.senderUserId,
      sender_device_id: claim.senderDeviceId,
    }, userId, deviceId);
    if (!capsule) throw new Error('VIEW_ONCE_DEVICE_COPY_DECRYPT_FAILED');

    const envelope = parseAegisMessageEnvelope(claim.parentBody);
    if (!envelope || envelope.messageId !== messageId) throw new Error('VIEW_ONCE_PARENT_MISMATCH');
    const plaintext = await openAegisMessage(claim.parentBody, capsule, {
      messageId,
      conversationId: claim.conversationId,
      senderId: claim.senderUserId,
    });
    if (!plaintext) throw new Error('VIEW_ONCE_PARENT_DECRYPT_FAILED');
    const media = parseMediaMessage(plaintext);
    if (!media) throw new Error('VIEW_ONCE_MEDIA_KEY_MISSING');

    const key = await importMediaKey(media.keyB64);
    const decrypted = await decryptMediaWithMetadata(encryptedMedia, key);
    const mime = decrypted.mimeType || (isVideoMediaLabel(media.label) ? 'video/mp4' : 'image/jpeg');
    const pendingResult: PendingOpenedViewOnce = {
      blob: new Blob([decrypted.data], { type: mime }),
      isVideo: mime.startsWith('video/') || isVideoMediaLabel(media.label),
      label: media.label,
      deviceId,
      claimToken: claim.claimToken,
      parentBody: claim.parentBody,
      imageUrl: claim.imageUrl,
    };
    pendingOpened.set(messageId, pendingResult);
    return finalizePending(messageId, pendingResult);
  } catch (error) {
    // Do not release after Ratchet decryption. The claim stays bound to this
    // device and any decrypted result remains memory-only until commit succeeds.
    return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
}

export function subscribeViewOnceConsumption(listener: (messageId: string) => void): () => void {
  if (!channel) return () => undefined;
  const handler = (event: MessageEvent<{ type?: string; messageId?: string }>) => {
    if (event.data?.type === 'consumed' && typeof event.data.messageId === 'string') {
      listener(event.data.messageId);
    }
  };
  channel.addEventListener('message', handler);
  return () => channel.removeEventListener('message', handler);
}
