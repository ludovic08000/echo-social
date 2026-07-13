import { supabase } from '@/integrations/supabase/client';
import { listFanoutTargets } from '@/e2ee-session/deviceRegistry';
import {
  encryptPlaintextForDeviceTarget,
  fanoutMessageCopies,
  insertFanoutCopyRows,
  type FanoutCopyRow,
} from '@/lib/messaging/multiDeviceFanout';
import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { loadPlaintext, loadPlaintextForCiphertext } from '@/lib/crypto/plaintextStore';

export type FanoutInput = Parameters<typeof fanoutMessageCopies>[0];
type FanoutResult = Awaited<ReturnType<typeof fanoutMessageCopies>>;
type FanoutAttempt = (input: FanoutInput) => Promise<FanoutResult>;

type ExpectedTarget = {
  userId: string;
  deviceId: string;
  devicePublicKey: string;
};

export interface FanoutCoverageResult extends FanoutResult {
  expected: number;
  covered: number;
  missingDeviceIds: string[];
}

export const DEFAULT_FANOUT_REPAIR_DELAYS_MS = [0, 500, 1_500, 4_000] as const;

export function fanoutNeedsRepair(
  result: { rows: unknown[]; hasTargets: boolean } | null,
): boolean {
  return result === null || (result.hasTargets && result.rows.length === 0);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function targetKey(target: Pick<ExpectedTarget, 'userId' | 'deviceId'>): string {
  return `${target.userId}:${target.deviceId}`;
}

async function listExpectedTargets(input: FanoutInput): Promise<ExpectedTarget[]> {
  if (isDeviceIdTemporary()) return [];
  const senderDeviceId = getCurrentDeviceId();

  const { data: participants, error } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', input.conversationId);
  if (error) throw error;

  const userIds = [...new Set((participants ?? []).map((row) => row.user_id))];
  if (userIds.length === 0) return [];

  const targets = await listFanoutTargets(input.senderUserId, userIds, { verifyPrekeys: false });
  const unique = new Map<string, ExpectedTarget>();
  for (const target of targets) {
    if (!target.devicePublicKey) continue;
    if (target.userId === input.senderUserId && target.deviceId === senderDeviceId) continue;
    unique.set(targetKey(target), {
      userId: target.userId,
      deviceId: target.deviceId,
      devicePublicKey: target.devicePublicKey,
    });
  }
  return [...unique.values()];
}

async function buildMissingRows(
  input: FanoutInput,
  targets: ExpectedTarget[],
  forceFreshSession: boolean,
): Promise<{ rows: FanoutCopyRow[]; successfulKeys: string[] }> {
  const senderDeviceId = getCurrentDeviceId();
  const results = await Promise.all(targets.map(async (target) => {
    try {
      const encrypted = await encryptPlaintextForDeviceTarget({
        conversationId: input.conversationId,
        senderUserId: input.senderUserId,
        senderDeviceId,
        recipientUserId: target.userId,
        recipientDeviceId: target.deviceId,
        recipientDevicePublicKey: target.devicePublicKey,
        plaintext: input.plaintext,
        forceFreshSession,
      });
      if (!encrypted) return null;
      return {
        key: targetKey(target),
        row: {
          message_id: input.messageId,
          recipient_user_id: target.userId,
          recipient_device_id: target.deviceId,
          sender_user_id: input.senderUserId,
          sender_device_id: encrypted.senderDeviceId,
          encrypted_body: encrypted.encryptedBody,
        } satisfies FanoutCopyRow,
      };
    } catch {
      return null;
    }
  }));

  const valid = results.filter((result): result is NonNullable<typeof result> => result !== null);
  return {
    rows: valid.map((result) => result.row),
    successfulKeys: valid.map((result) => result.key),
  };
}

/**
 * Ensure every currently trusted target device has a durable encrypted copy.
 * Partial success is not success: iPhone receiving a copy must not hide that
 * Windows is still missing one. Retries use a fresh initiating session after
 * the first pass, matching Sesame's retry guidance for orphaned sessions.
 */
export async function ensureFanoutCoverageWithRetry(
  input: FanoutInput,
  initiallyCoveredDeviceIds: readonly string[] = [],
  delaysMs: readonly number[] = DEFAULT_FANOUT_REPAIR_DELAYS_MS,
): Promise<FanoutCoverageResult> {
  const covered = new Set(initiallyCoveredDeviceIds);
  let inserted = 0;
  let latestTargets: ExpectedTarget[] = [];

  for (let attemptIndex = 0; attemptIndex < delaysMs.length; attemptIndex += 1) {
    await sleep(delaysMs[attemptIndex]);
    latestTargets = await listExpectedTargets(input);
    if (latestTargets.length === 0) {
      return { inserted, multiDevice: false, expected: 0, covered: 0, missingDeviceIds: [] };
    }

    const expectedKeys = new Set(latestTargets.map(targetKey));
    for (const key of [...covered]) {
      if (!expectedKeys.has(key)) covered.delete(key);
    }

    const missing = latestTargets.filter((target) => !covered.has(targetKey(target)));
    if (missing.length === 0) {
      return {
        inserted,
        multiDevice: true,
        expected: latestTargets.length,
        covered: latestTargets.length,
        missingDeviceIds: [],
      };
    }

    const built = await buildMissingRows(input, missing, attemptIndex > 0);
    if (built.rows.length > 0) {
      const result = await insertFanoutCopyRows(input, built.rows);
      if (result.inserted > 0) {
        inserted += result.inserted;
        built.successfulKeys.forEach((key) => covered.add(key));
      }
    }
  }

  latestTargets = await listExpectedTargets(input);
  const missing = latestTargets.filter((target) => !covered.has(targetKey(target)));
  if (missing.length === 0) {
    return {
      inserted,
      multiDevice: latestTargets.length > 0,
      expected: latestTargets.length,
      covered: latestTargets.length,
      missingDeviceIds: [],
    };
  }

  const failure = new Error('E_FANOUT_PARTIAL_COVERAGE_AFTER_RETRY');
  (failure as Error & { missingDeviceIds?: string[] }).missingDeviceIds = missing.map((target) => target.deviceId);
  throw failure;
}

/**
 * Backward-compatible zero-copy repair entry point. Tests may inject a simple
 * attempt function; production uses complete per-device coverage instead.
 */
export async function repairFanoutWithRetry(
  input: FanoutInput,
  attempt: FanoutAttempt = fanoutMessageCopies,
  delaysMs: readonly number[] = DEFAULT_FANOUT_REPAIR_DELAYS_MS,
): Promise<FanoutResult> {
  if (attempt === fanoutMessageCopies) {
    const result = await ensureFanoutCoverageWithRetry(input, [], delaysMs);
    return { inserted: result.inserted, multiDevice: result.multiDevice };
  }

  let lastResult: FanoutResult | null = null;
  let lastError: unknown = null;
  for (const delay of delaysMs) {
    await sleep(delay);
    try {
      const result = await attempt(input);
      lastResult = result;
      lastError = null;
      if (!result.multiDevice || result.inserted > 0) return result;
    } catch (error) {
      lastError = error;
    }
  }

  const failure = new Error('E_FANOUT_ZERO_COPIES_AFTER_RETRY');
  (failure as Error & { cause?: unknown; lastResult?: FanoutResult | null }).cause = lastError;
  (failure as Error & { cause?: unknown; lastResult?: FanoutResult | null }).lastResult = lastResult;
  throw failure;
}

const backgroundCoverage = new Map<string, Promise<void>>();

async function loadSentMessageForCoverage(messageId: string): Promise<FanoutInput | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: message } = await supabase
    .from('messages')
    .select('id, conversation_id, sender_id, body')
    .eq('id', messageId)
    .maybeSingle();
  if (!message || message.sender_id !== user.id) return null;

  const plaintext =
    await loadPlaintext(messageId).catch(() => null) ??
    await loadPlaintextForCiphertext(message.body).catch(() => null);
  if (!plaintext) return null;

  return {
    messageId,
    conversationId: message.conversation_id,
    senderUserId: user.id,
    plaintext,
  };
}

/**
 * Every successful local send dispatches this same targeted retry event after
 * caching plaintext. The listener performs a final all-device coverage pass,
 * including messages whose initial fan-out succeeded for only some devices.
 */
function scheduleBackgroundCoverage(messageId: string): void {
  if (!messageId || backgroundCoverage.has(messageId)) return;

  const task = (async () => {
    const plaintextDelays = [250, 1_000, 3_000];
    let input: FanoutInput | null = null;
    for (const delay of plaintextDelays) {
      await sleep(delay);
      input = await loadSentMessageForCoverage(messageId);
      if (input) break;
    }
    if (!input) return;

    const coverage = await ensureFanoutCoverageWithRetry(input);
    if (coverage.covered > 0 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('forsure:fanout-coverage-ready', {
        detail: { messageId, expected: coverage.expected, covered: coverage.covered },
      }));
    }
  })()
    .catch((error) => {
      console.warn('[fanout-coverage] background repair incomplete', {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => backgroundCoverage.delete(messageId));

  backgroundCoverage.set(messageId, task);
}

if (typeof window !== 'undefined') {
  const marker = '__forsureFanoutCoverageListenerV1';
  const globalWindow = window as typeof window & Record<string, unknown>;
  if (!globalWindow[marker]) {
    globalWindow[marker] = true;
    window.addEventListener('forsure-decrypt-retry', (event: Event) => {
      const messageId = (event as CustomEvent<{ messageId?: string }>).detail?.messageId;
      if (messageId) scheduleBackgroundCoverage(messageId);
    });
  }
}

export const __test__ = { targetKey };
