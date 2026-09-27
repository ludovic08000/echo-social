import { supabase } from '@/integrations/supabase/client';
import type { FanoutCopyRow } from '@/lib/messaging/multiDeviceFanout';

const MINT_TIMEOUT_MS = 4_000;
const RELAY_TIMEOUT_MS = 4_000;
const PUBLISH_TIMEOUT_MS = 8_000;
const RELAY_CONCURRENCY = 4;
const MAX_PENDING_WAKEUPS = 100;

interface MintedRelayToken {
  token: string;
  recipient_user_id: string;
  conversation_id: string;
}

export interface SealedSenderPublishResult {
  attempted: number;
  relayed: number;
  failed: number;
}

export interface SealedSenderWakeup {
  id: string;
  context_id: string | null;
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function isMintedRelayToken(value: unknown): value is MintedRelayToken {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MintedRelayToken>;
  return typeof candidate.token === 'string'
    && typeof candidate.recipient_user_id === 'string'
    && typeof candidate.conversation_id === 'string';
}

async function resolveWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeout = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function relayWakeup(input: {
  messageId: string;
  conversationId: string;
  recipientUserId: string;
  deadlineAt: number;
}): Promise<boolean> {
  const mintBudgetMs = Math.min(MINT_TIMEOUT_MS, input.deadlineAt - Date.now());
  if (mintBudgetMs <= 0) return false;
  const mintResult = await resolveWithin(
    supabase.functions.invoke('sealed-mint-token', {
      body: {
        recipient_user_id: input.recipientUserId,
        conversation_id: input.conversationId,
        context_id: input.messageId,
      },
    }),
    mintBudgetMs,
  );
  if (!mintResult) return false;
  const { data, error } = mintResult;
  if (error || !isMintedRelayToken(data)) return false;
  if (
    data.recipient_user_id !== input.recipientUserId
    || data.conversation_id !== input.conversationId
  ) {
    return false;
  }

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/u, '');
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) return false;

  const relayBudgetMs = Math.min(RELAY_TIMEOUT_MS, input.deadlineAt - Date.now());
  if (relayBudgetMs <= 0) return false;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), relayBudgetMs);
  try {
    // Invariant : le relais ne reçoit jamais le JWT de l'expéditeur. Le jeton
    // éphémère, lié au destinataire, est l'unique autorisation de dépôt.
    const response = await globalThis.fetch(`${supabaseUrl}/functions/v1/sealed-relay`, {
      method: 'POST',
      headers: {
        apikey: publishableKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        token: data.token,
        conversation_id: input.conversationId,
        recipient_user_id: input.recipientUserId,
        anonymous_sender_tag: randomBase64Url(32),
        sealed_payload: randomBase64Url(32),
        sealed_header: {
          kind: 'aegis_inbox_wakeup',
          protocol: 'sealed_sender',
        },
      }),
      signal: abort.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrency<T>(
  values: T[],
  limit: number,
  operation: (value: T) => Promise<boolean>,
): Promise<boolean[]> {
  const results = new Array<boolean>(values.length).fill(false);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await operation(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Publishes a metadata-minimised wakeup after the canonical Aegis transaction.
 * Failure is intentionally non-fatal: polling and the legacy realtime event
 * remain available while Sealed Sender is rolled out.
 */
export async function publishSealedSenderWakeups(input: {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  copies: FanoutCopyRow[];
}): Promise<SealedSenderPublishResult> {
  const recipients = [...new Set(
    input.copies
      .map((copy) => copy.recipient_user_id)
      .filter((recipientId) => recipientId && recipientId !== input.senderUserId),
  )];
  if (recipients.length === 0) return { attempted: 0, relayed: 0, failed: 0 };

  try {
    const deadlineAt = Date.now() + PUBLISH_TIMEOUT_MS;
    const outcomes = await mapWithConcurrency(
      recipients,
      RELAY_CONCURRENCY,
      (recipientUserId) => relayWakeup({
        messageId: input.messageId,
        conversationId: input.conversationId,
        recipientUserId,
        deadlineAt,
      }),
    );
    const relayed = outcomes.filter(Boolean).length;
    return {
      attempted: recipients.length,
      relayed,
      failed: recipients.length - relayed,
    };
  } catch {
    return { attempted: recipients.length, relayed: 0, failed: recipients.length };
  }
}

export async function pullSealedSenderWakeups(): Promise<SealedSenderWakeup[]> {
  const { data, error } = await supabase
    .from('sealed_sender_messages')
    .select('id, context_id')
    .eq('delivery_state', 'queued')
    .order('created_at', { ascending: true })
    .limit(MAX_PENDING_WAKEUPS);
  if (error) throw error;
  return (data ?? []) as SealedSenderWakeup[];
}

export async function acknowledgeSealedSenderWakeups(messageIds: string[]): Promise<void> {
  const uniqueIds = [...new Set(messageIds.filter(Boolean))];
  if (uniqueIds.length === 0) return;
  const { error } = await supabase.rpc('ack_sealed_sender_wakeups', {
    p_message_ids: uniqueIds,
  });
  if (error) throw error;
}
