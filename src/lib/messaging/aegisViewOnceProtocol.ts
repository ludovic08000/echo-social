export const AEGIS_VIEW_ONCE_PROTOCOL = 'aegis-view-once-v1';

export type ViewOnceBeginState = 'claimed' | 'consumed' | 'claimed_elsewhere' | 'not_found' | 'sender';

export interface ViewOnceClaimReceipt {
  state: 'claimed';
  protocol: typeof AEGIS_VIEW_ONCE_PROTOCOL;
  messageId: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  claimToken: string;
  claimExpiresAt: string;
  parentBody: string;
  imageUrl: string;
  encryptedBody: string;
}

export interface ViewOnceCommitReceipt {
  state: 'committed';
  protocol: typeof AEGIS_VIEW_ONCE_PROTOCOL;
  messageId: string;
  claimToken: string;
  existing: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export function parseViewOnceBeginState(value: unknown): ViewOnceBeginState | null {
  const row = record(value);
  const state = row?.state;
  return state === 'claimed' || state === 'consumed' || state === 'claimed_elsewhere' || state === 'not_found' || state === 'sender'
    ? state
    : null;
}

export function parseViewOnceClaimReceipt(value: unknown): ViewOnceClaimReceipt | null {
  const row = record(value);
  if (!row || row.state !== 'claimed' || row.protocol !== AEGIS_VIEW_ONCE_PROTOCOL) return null;
  const messageId = row.message_id;
  const conversationId = row.conversation_id;
  const senderUserId = row.sender_user_id;
  const senderDeviceId = row.sender_device_id;
  const claimToken = row.claim_token;
  const claimExpiresAt = row.claim_expires_at;
  const parentBody = row.parent_body;
  const imageUrl = row.image_url;
  const encryptedBody = row.encrypted_body;
  if (
    typeof messageId !== 'string' || !UUID_RE.test(messageId) ||
    typeof conversationId !== 'string' || !UUID_RE.test(conversationId) ||
    typeof senderUserId !== 'string' || !UUID_RE.test(senderUserId) ||
    typeof senderDeviceId !== 'string' || senderDeviceId.length < 8 ||
    typeof claimToken !== 'string' || !UUID_RE.test(claimToken) ||
    typeof claimExpiresAt !== 'string' || !Number.isFinite(Date.parse(claimExpiresAt)) ||
    typeof parentBody !== 'string' || parentBody.length < 16 ||
    typeof imageUrl !== 'string' || !/^https:\/\//i.test(imageUrl) ||
    typeof encryptedBody !== 'string' || !encryptedBody.startsWith('aegis1.')
  ) {
    return null;
  }
  return {
    state: 'claimed',
    protocol: AEGIS_VIEW_ONCE_PROTOCOL,
    messageId,
    conversationId,
    senderUserId,
    senderDeviceId,
    claimToken,
    claimExpiresAt,
    parentBody,
    imageUrl,
    encryptedBody,
  };
}

export function parseViewOnceCommitReceipt(value: unknown): ViewOnceCommitReceipt | null {
  const row = record(value);
  if (!row || row.state !== 'committed' || row.protocol !== AEGIS_VIEW_ONCE_PROTOCOL) return null;
  const messageId = row.message_id;
  const claimToken = row.claim_token;
  if (
    typeof messageId !== 'string' || !UUID_RE.test(messageId) ||
    typeof claimToken !== 'string' || !UUID_RE.test(claimToken) ||
    typeof row.existing !== 'boolean'
  ) {
    return null;
  }
  return {
    state: 'committed',
    protocol: AEGIS_VIEW_ONCE_PROTOCOL,
    messageId,
    claimToken,
    existing: row.existing,
  };
}

export function shouldInstallViewOnceContent(args: {
  beginMessageId: string;
  expectedMessageId: string;
  parentEnvelopeMessageId: string | null;
  hasImageUrl: boolean;
  hasMediaKey: boolean;
}): boolean {
  return args.beginMessageId === args.expectedMessageId
    && args.parentEnvelopeMessageId === args.expectedMessageId
    && args.hasImageUrl
    && args.hasMediaKey;
}
