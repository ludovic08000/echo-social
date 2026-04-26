/**
 * Re-sync E2EE keys after a restore.
 *
 * Run this whenever local keys have just been restored (Keychain snapshot,
 * password unwrap, recovery key, device link). It re-publishes the device
 * identity / signed prekey / OPK pool to the server, drops stale ratchet
 * sessions so peers re-negotiate fresh chains, and re-attempts decryption of
 * any messages still sitting as encrypted placeholders by querying the
 * device-copy fallback.
 *
 * Safe to call multiple times — every step is idempotent and non-fatal.
 */

import { supabase } from '@/integrations/supabase/client';
import {
  getCurrentDeviceId,
  getCurrentDeviceLabel,
  getCurrentPlatform,
} from '@/lib/messaging/currentDevice';
import { getOrCreateIdentityKeys, exportPublicKeyBundle } from '@/lib/crypto/keyManager';
import {
  refreshSignedPrekeyIfNeeded,
  refreshDeviceSignedPrekeyIfNeeded,
  refillDeviceOneTimePrekeysIfNeeded,
} from '@/lib/crypto/x3dh';
import { getOrCreateDeviceKxKey } from '@/lib/crypto/deviceKx';
import { clearAllDeviceSessions } from '@/lib/crypto/deviceRatchet';
import { tryReadDeviceCopy } from '@/lib/messaging/multiDeviceFanout';
import { syncBackupToServer, syncKeychainSnapshotFromLocal, hasLocalKeys } from '@/lib/crypto/accountKeyBackup';
import { logCryptoError, logCryptoException } from '@/lib/crypto/errorLogger';

export type ResyncStep = 'identity' | 'spk' | 'opks' | 'ratchets' | 'replay' | 'snapshot' | 'backup';

export type DiagLevel = 'info' | 'warn' | 'error' | 'success';

export interface DiagEntry {
  ts: number;
  step: ResyncStep | 'init' | 'done';
  level: DiagLevel;
  message: string;
  data?: Record<string, unknown>;
}

export interface MessageReplayDetail {
  messageId: string;
  conversationId: string;
  bodyKind: string | null;
  outcome: 'recovered' | 'failed' | 'empty';
  error?: string;
  durationMs: number;
}

export interface ResyncReport {
  ok: boolean;
  steps: Record<ResyncStep, 'ok' | 'skipped' | 'error'>;
  recoveredMessages: number;
  scannedMessages: number;
  errors: string[];
  durationMs: number;
  /** Full chronological diagnostic trace (only populated when diagnostic=true). */
  trace?: DiagEntry[];
  /** Per-message replay details (only populated when diagnostic=true). */
  replayDetails?: MessageReplayDetail[];
  deviceId?: string;
  platform?: string;
}

const RECENT_MESSAGE_WINDOW = 50;

/** Lightweight diagnostic recorder. Pass-through when diagnostic mode is off. */
class DiagRecorder {
  private entries: DiagEntry[] = [];
  constructor(private enabled: boolean) {}
  push(step: DiagEntry['step'], level: DiagLevel, message: string, data?: Record<string, unknown>) {
    if (!this.enabled) return;
    this.entries.push({ ts: Date.now(), step, level, message, data });
    // Mirror to console with a unique tag so it's easy to filter in iOS web inspector.
    const tag = `[e2ee-diag:${step}]`;
    if (level === 'error') console.error(tag, message, data ?? '');
    else if (level === 'warn') console.warn(tag, message, data ?? '');
    else console.log(tag, message, data ?? '');
  }
  drain(): DiagEntry[] { return this.entries.slice(); }
}

/**
 * Republish identity bundle + per-device SPK + OPK pool. Without this, peers
 * keep encrypting against a stale prekey bundle and every new message lands
 * as undecryptable.
 */
async function republishDeviceIdentity(userId: string, deviceId: string): Promise<{ identity: boolean; spk: boolean; opks: boolean }> {
  const result = { identity: false, spk: false, opks: false };

  const keys = await getOrCreateIdentityKeys(userId);
  const bundle = await exportPublicKeyBundle(keys);
  if (!bundle?.identityKey || !bundle?.signingKey || !keys?.signingPrivateKey) {
    throw new Error('identity bundle incomplete');
  }

  let devicePublicKeyB64 = bundle.identityKey;
  try {
    const kx = await getOrCreateDeviceKxKey(deviceId);
    if (kx?.publicB64) devicePublicKeyB64 = kx.publicB64;
  } catch {
    // fall back silently to the shared identity key
  }

  const { error: devErr } = await supabase
    .from('user_devices')
    .upsert(
      {
        user_id: userId,
        device_id: deviceId,
        device_name: getCurrentDeviceLabel(),
        device_public_key: devicePublicKeyB64,
        platform: getCurrentPlatform(),
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : null,
        is_active: true,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,device_id' },
    );
  result.identity = !devErr;
  if (devErr) throw new Error(`user_devices upsert failed: ${devErr.message}`);

  try {
    await refreshSignedPrekeyIfNeeded(userId, keys.signingPrivateKey);
  } catch (e) {
    console.warn('[resync] shared SPK refresh failed:', e);
  }

  try {
    await refreshDeviceSignedPrekeyIfNeeded(userId, deviceId, keys.signingPrivateKey);
    result.spk = true;
  } catch (e) {
    console.warn('[resync] device SPK refresh failed:', e);
  }

  try {
    await refillDeviceOneTimePrekeysIfNeeded(userId, deviceId);
    result.opks = true;
  } catch (e) {
    console.warn('[resync] OPK refill failed:', e);
  }

  return result;
}

/**
 * Walk the recent inbox of every conversation the user belongs to and try to
 * recover any message whose body still looks encrypted. Decryption is
 * delegated to {@link tryReadDeviceCopy}; we only count successes here so the
 * UI can surface what was healed.
 */
async function replayRecentDeviceCopies(userId: string): Promise<{ scanned: number; recovered: number }> {
  let scanned = 0;
  let recovered = 0;

  const { data: convos } = await supabase
    .from('conversation_participants')
    .select('conversation_id')
    .eq('user_id', userId);

  if (!convos || convos.length === 0) return { scanned, recovered };

  for (const c of convos as Array<{ conversation_id: string }>) {
    const { data: rows } = await supabase
      .from('messages')
      .select('id, body, body_kind, sender_id')
      .eq('conversation_id', c.conversation_id)
      .order('created_at', { ascending: false })
      .limit(RECENT_MESSAGE_WINDOW);

    if (!rows) continue;

    for (const row of rows as Array<{ id: string; body: string | null; body_kind?: string | null; sender_id: string }>) {
      if (row.sender_id === userId) continue;
      const body = row.body ?? '';
      // Heuristic: only retry rows that look like an encrypted envelope or are
      // explicitly tagged as multi-device copies. Plain placeholders / system
      // messages are skipped to keep the replay cheap.
      const looksEncrypted = body.startsWith('v') || body.startsWith('{') || row.body_kind === 'multi_device';
      if (!looksEncrypted) continue;
      scanned += 1;
      try {
        const pt = await tryReadDeviceCopy(row.id);
        if (pt !== null && pt.length > 0) recovered += 1;
      } catch {
        // ignored — best-effort
      }
    }
  }

  return { scanned, recovered };
}

export async function resyncE2EE(userId: string): Promise<ResyncReport> {
  const t0 = Date.now();
  const report: ResyncReport = {
    ok: false,
    steps: {
      identity: 'skipped',
      spk: 'skipped',
      opks: 'skipped',
      ratchets: 'skipped',
      replay: 'skipped',
      snapshot: 'skipped',
      backup: 'skipped',
    },
    recoveredMessages: 0,
    scannedMessages: 0,
    errors: [],
    durationMs: 0,
  };

  if (!userId) {
    report.errors.push('missing userId');
    report.durationMs = Date.now() - t0;
    return report;
  }

  if (!(await hasLocalKeys())) {
    report.errors.push('no local keys to resync — restore first');
    report.durationMs = Date.now() - t0;
    return report;
  }

  const deviceId = getCurrentDeviceId();

  // 1. Republish identity / SPK / OPKs
  try {
    const pub = await republishDeviceIdentity(userId, deviceId);
    report.steps.identity = pub.identity ? 'ok' : 'error';
    report.steps.spk = pub.spk ? 'ok' : 'error';
    report.steps.opks = pub.opks ? 'ok' : 'error';
  } catch (e) {
    report.steps.identity = 'error';
    report.errors.push(`republish: ${e instanceof Error ? e.message : String(e)}`);
    logCryptoException('restore', e, { severity: 'error', metadata: { stage: 'resync_republish', userId } });
  }

  // 2. Drop stale device-pair ratchets so the next outbound message renegotiates X3DH.
  try {
    await clearAllDeviceSessions();
    report.steps.ratchets = 'ok';
  } catch (e) {
    report.steps.ratchets = 'error';
    report.errors.push(`ratchet clear: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3. Replay device-copy fallback on recent inbox to recover what we can.
  try {
    const replay = await replayRecentDeviceCopies(userId);
    report.scannedMessages = replay.scanned;
    report.recoveredMessages = replay.recovered;
    report.steps.replay = 'ok';
  } catch (e) {
    report.steps.replay = 'error';
    report.errors.push(`replay: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 4. Refresh the on-device Keychain snapshot so the new state survives a
  //    WebView wipe.
  try {
    const ok = await syncKeychainSnapshotFromLocal(userId);
    report.steps.snapshot = ok ? 'ok' : 'skipped';
  } catch (e) {
    report.steps.snapshot = 'error';
    report.errors.push(`snapshot: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 5. Push the fresh state to the encrypted server backup (debounced inside).
  try {
    const ok = await syncBackupToServer();
    report.steps.backup = ok ? 'ok' : 'skipped';
  } catch (e) {
    report.steps.backup = 'error';
    report.errors.push(`backup: ${e instanceof Error ? e.message : String(e)}`);
  }

  report.durationMs = Date.now() - t0;
  report.ok = report.errors.length === 0;

  logCryptoError({
    severity: report.ok ? 'info' : 'warning',
    context: 'restore',
    errorCode: 'E2EE_RESYNC_DONE',
    errorMessage: `E2EE resync ${report.ok ? 'succeeded' : 'completed with errors'} (${report.recoveredMessages}/${report.scannedMessages} recovered)`,
    metadata: {
      userId,
      deviceId,
      recovered: report.recoveredMessages,
      scanned: report.scannedMessages,
      durationMs: report.durationMs,
      steps: report.steps,
      errors: report.errors,
    },
  });

  // Notify the rest of the app — message lists can refresh, banners can hide.
  try {
    window.dispatchEvent(
      new CustomEvent('forsure:e2ee-resync-complete', { detail: report }),
    );
  } catch {
    // SSR / non-window context — ignore
  }

  return report;
}
