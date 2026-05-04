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
  hydrateDeviceId,
} from '@/lib/messaging/currentDevice';
import {
  getOrCreateIdentityKeys,
  exportPublicKeyBundle,
  exportPublicKeyBundleFromStoredKeys,
  PinUnlockRequiredError,
} from '@/lib/crypto/keyManager';
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
  /** True when keys exist but are locked behind the messaging PIN. */
  needsPinUnlock?: boolean;
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
const RESYNC_BUILD = 'e2ee-ios-device-v3';

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name && error.name !== 'Error' ? `${error.name}: ` : '';
    return `${name}${error.message}`;
  }
  return String(error);
}

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
const ALLOWED_PLATFORMS = new Set(['ios', 'android', 'web']);

function normalizePlatform(p: string | null | undefined): 'ios' | 'android' | 'web' {
  const v = (p || '').toLowerCase();
  if (v === 'ios' || v === 'android' || v === 'web') return v;
  // 'mobile' or anything else → fall back to a safe value the table accepts.
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  }
  return 'web';
}

function isNonEmptyB64(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && /^[A-Za-z0-9+/_\-=]+$/.test(s);
}

async function republishDeviceIdentity(
  userId: string,
  deviceId: string,
  diag?: DiagRecorder,
): Promise<{ identity: boolean; spk: boolean; opks: boolean }> {
  const result = { identity: false, spk: false, opks: false };

  diag?.push('identity', 'info', 'stage load_identity_keys');
  const keys = await getOrCreateIdentityKeys(userId).catch((e) => {
    throw new Error(`load_identity_keys: ${describeError(e)}`);
  });

  diag?.push('identity', 'info', 'stage export_public_bundle');
  let bundle: { identityKey: string; signingKey: string; fingerprint: string };
  try {
    bundle = await exportPublicKeyBundle(keys);
  } catch (e) {
    const original = describeError(e);
    diag?.push('identity', 'warn', 'public CryptoKey export failed, trying stored JWK fallback', {
      error: original,
    });
    const storedBundle = await exportPublicKeyBundleFromStoredKeys(userId).catch((storedErr) => {
      throw new Error(`export_public_bundle: ${original}; stored_jwk_fallback: ${describeError(storedErr)}`);
    });
    if (!storedBundle) {
      throw new Error(`export_public_bundle: ${original}; stored_jwk_fallback: missing stored identity`);
    }
    bundle = storedBundle;
  }
  if (!bundle?.identityKey || !bundle?.signingKey || !keys?.signingPrivateKey) {
    throw new Error('identity bundle incomplete (identityKey/signingKey missing)');
  }

  let devicePublicKeyB64: string = bundle.identityKey;
  try {
    diag?.push('identity', 'info', 'stage device_kx');
    const kx = await getOrCreateDeviceKxKey(deviceId);
    if (kx?.publicB64 && isNonEmptyB64(kx.publicB64)) devicePublicKeyB64 = kx.publicB64;
  } catch (e) {
    diag?.push('identity', 'warn', 'device kx unavailable, fallback to identity key', {
      error: describeError(e),
    });
    console.warn('[resync] device kx unavailable, fallback to identity key:', e);
  }

  // Hard validation BEFORE the upsert — these are the most common causes of
  // the cryptic "Data provided to an operation does not meet requirements".
  if (!userId || typeof userId !== 'string') {
    throw new Error(`invalid user_id type=${typeof userId}`);
  }
  if (!deviceId || typeof deviceId !== 'string' || deviceId.length < 8) {
    throw new Error(`invalid device_id (len=${deviceId?.length ?? 0})`);
  }
  if (!isNonEmptyB64(devicePublicKeyB64)) {
    throw new Error(`invalid device_public_key type=${typeof devicePublicKeyB64} len=${(devicePublicKeyB64 as any)?.length ?? 0}`);
  }

  const platform = normalizePlatform(getCurrentPlatform());
  const deviceName = (getCurrentDeviceLabel() || 'Unknown device').slice(0, 120);
  const userAgent = typeof navigator !== 'undefined' ? (navigator.userAgent || '').slice(0, 500) : null;

  const payload = {
    user_id: userId,
    device_id: deviceId,
    device_name: deviceName,
    device_public_key: devicePublicKeyB64,
    platform,
    user_agent: userAgent,
    is_active: true,
    last_seen_at: new Date().toISOString(),
  };

  // Diagnostic log — NEVER log private key material.
  diag?.push('identity', 'info', 'stage user_public_keys.upsert', {
    identityKeyLen: bundle.identityKey.length,
    signingKeyLen: bundle.signingKey.length,
    fingerprint: bundle.fingerprint,
  });
  const { error: pubErr } = await supabase
    .from('user_public_keys')
    .upsert({
      user_id: userId,
      identity_key: bundle.identityKey,
      signing_key: bundle.signingKey,
      fingerprint: bundle.fingerprint,
      kem_type: 'X25519',
      is_active: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,is_active' });
  if (pubErr) {
    throw new Error(`user_public_keys upsert failed: ${pubErr.message} (code=${(pubErr as any).code ?? 'n/a'}, details=${(pubErr as any).details ?? 'n/a'})`);
  }

  console.log('[resync] user_devices.upsert payload', {
    user_id: payload.user_id,
    device_id: payload.device_id,
    device_id_len: payload.device_id.length,
    platform: payload.platform,
    device_name: payload.device_name,
    device_public_key_type: typeof payload.device_public_key,
    device_public_key_len: payload.device_public_key.length,
    user_agent_len: payload.user_agent?.length ?? 0,
  });

  diag?.push('identity', 'info', 'stage user_devices.upsert', {
    deviceIdLen: payload.device_id.length,
    platform: payload.platform,
    devicePublicKeyLen: payload.device_public_key.length,
  });
  const { error: devErr } = await supabase
    .from('user_devices')
    .upsert(payload, { onConflict: 'user_id,device_id' });
  if (devErr) {
    console.error('[resync] user_devices.upsert failed', {
      code: (devErr as any).code,
      message: devErr.message,
      details: (devErr as any).details,
      hint: (devErr as any).hint,
    });
    throw new Error(`user_devices upsert failed: ${devErr.message} (code=${(devErr as any).code ?? 'n/a'}, details=${(devErr as any).details ?? 'n/a'})`);
  }
  result.identity = true;

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
async function replayRecentDeviceCopies(
  userId: string,
  diag: DiagRecorder,
  details: MessageReplayDetail[] | null,
): Promise<{ scanned: number; recovered: number }> {
  let scanned = 0;
  let recovered = 0;

  const { data: convos, error: convErr } = await supabase
    .from('conversation_participants')
    .select('conversation_id')
    .eq('user_id', userId);

  if (convErr) {
    diag.push('replay', 'error', 'failed to list conversations', { error: convErr.message });
    throw convErr;
  }
  if (!convos || convos.length === 0) {
    diag.push('replay', 'info', 'no conversations to scan');
    return { scanned, recovered };
  }
  diag.push('replay', 'info', `scanning ${convos.length} conversation(s)`);

  for (const c of convos as Array<{ conversation_id: string }>) {
    const { data: rows, error: msgErr } = await supabase
      .from('messages')
      .select('id, body, body_kind, sender_id')
      .eq('conversation_id', c.conversation_id)
      .order('created_at', { ascending: false })
      .limit(RECENT_MESSAGE_WINDOW);

    if (msgErr) {
      diag.push('replay', 'warn', 'message fetch failed', {
        conversationId: c.conversation_id,
        error: msgErr.message,
      });
      continue;
    }
    if (!rows) continue;

    let convScanned = 0;
    let convRecovered = 0;

    for (const row of rows as Array<{ id: string; body: string | null; body_kind?: string | null; sender_id: string }>) {
      if (row.sender_id === userId) continue;
      const body = row.body ?? '';
      const looksEncrypted = body.startsWith('v') || body.startsWith('{') || row.body_kind === 'multi_device';
      if (!looksEncrypted) continue;
      scanned += 1;
      convScanned += 1;
      const t = Date.now();
      try {
        const pt = await tryReadDeviceCopy(row.id, row.sender_id);
        const dur = Date.now() - t;
        if (pt !== null && pt.length > 0) {
          recovered += 1;
          convRecovered += 1;
          details?.push({
            messageId: row.id,
            conversationId: c.conversation_id,
            bodyKind: row.body_kind ?? null,
            outcome: 'recovered',
            durationMs: dur,
          });
        } else {
          details?.push({
            messageId: row.id,
            conversationId: c.conversation_id,
            bodyKind: row.body_kind ?? null,
            outcome: 'empty',
            durationMs: dur,
          });
        }
      } catch (e) {
        const dur = Date.now() - t;
        const errMsg = e instanceof Error ? e.message : String(e);
        details?.push({
          messageId: row.id,
          conversationId: c.conversation_id,
          bodyKind: row.body_kind ?? null,
          outcome: 'failed',
          error: errMsg,
          durationMs: dur,
        });
        diag.push('replay', 'warn', `decrypt failed for message ${row.id.slice(0, 8)}`, {
          error: errMsg,
        });
      }
    }

    if (convScanned > 0) {
      diag.push('replay', 'info', `conversation ${c.conversation_id.slice(0, 8)} → ${convRecovered}/${convScanned} recovered`);
    }
  }

  return { scanned, recovered };
}

export interface ResyncOptions {
  /** Capture full diagnostic trace + per-message details on the returned report. */
  diagnostic?: boolean;
}

export async function resyncE2EE(userId: string, options: ResyncOptions = {}): Promise<ResyncReport> {
  const t0 = Date.now();
  const diagnostic = options.diagnostic === true;
  const diag = new DiagRecorder(diagnostic);
  const replayDetails: MessageReplayDetail[] | null = diagnostic ? [] : null;

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

  diag.push('init', 'info', 'starting E2EE resync', { userId, diagnostic, build: RESYNC_BUILD });

  if (!userId) {
    report.errors.push('missing userId');
    report.durationMs = Date.now() - t0;
    diag.push('init', 'error', 'missing userId — abort');
    if (diagnostic) { report.trace = diag.drain(); report.replayDetails = replayDetails ?? []; }
    return report;
  }

  if (!(await hasLocalKeys())) {
    report.errors.push('no local keys to resync — restore first');
    report.durationMs = Date.now() - t0;
    diag.push('init', 'error', 'no local keys — abort (restore first)');
    if (diagnostic) { report.trace = diag.drain(); report.replayDetails = replayDetails ?? []; }
    return report;
  }

  const deviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
  const platform = getCurrentPlatform();
  report.deviceId = deviceId;
  report.platform = platform;
  diag.push('init', 'info', 'context resolved', { deviceId, platform });

  // 1. Republish identity / SPK / OPKs
  const tIdent = Date.now();
  try {
    const pub = await republishDeviceIdentity(userId, deviceId, diag);
    report.steps.identity = pub.identity ? 'ok' : 'error';
    report.steps.spk = pub.spk ? 'ok' : 'error';
    report.steps.opks = pub.opks ? 'ok' : 'error';
    diag.push('identity', pub.identity ? 'success' : 'error', 'identity bundle published', {
      durationMs: Date.now() - tIdent,
      ...pub,
    });
  } catch (e) {
    report.steps.identity = 'error';
    const msg = describeError(e);
    report.errors.push(`republish: ${msg}`);
    diag.push('identity', 'error', 'identity republish failed', { error: msg });
    logCryptoException('restore', e, { severity: 'error', metadata: { stage: 'resync_republish', userId } });

    if (e instanceof PinUnlockRequiredError || msg.toLowerCase().includes('pin unlock required')) {
      report.needsPinUnlock = true;
      report.durationMs = Date.now() - t0;
      diag.push('done', 'warn', 'resync paused until PIN unlock', {
        ok: false,
        errors: report.errors.length,
      });
      if (diagnostic) {
        report.trace = diag.drain();
        report.replayDetails = replayDetails ?? [];
      }
      try {
        window.dispatchEvent(
          new CustomEvent('forsure:e2ee-pin-unlock-required', { detail: report }),
        );
      } catch {}
      return report;
    }
  }

  // 2. Drop stale device-pair ratchets so the next outbound message renegotiates X3DH.
  //    Skip if identity republish failed — clearing sessions while peers still
  //    pin our old prekeys would lock conversations into an undecryptable state.
  const tRatch = Date.now();
  if (report.steps.identity !== 'ok') {
    report.steps.ratchets = 'skipped';
    diag.push('ratchets', 'warn', 'skipped: identity republish failed', {});
  } else {
    try {
      await clearAllDeviceSessions();
      report.steps.ratchets = 'ok';
      diag.push('ratchets', 'success', 'cleared stale device ratchets', { durationMs: Date.now() - tRatch });
    } catch (e) {
      report.steps.ratchets = 'error';
      const msg = e instanceof Error ? e.message : String(e);
      report.errors.push(`ratchet clear: ${msg}`);
      diag.push('ratchets', 'error', 'ratchet clear failed', { error: msg });
    }
  }

  // 3. Replay device-copy fallback on recent inbox to recover what we can.
  const tReplay = Date.now();
  try {
    const replay = await replayRecentDeviceCopies(userId, diag, replayDetails);
    report.scannedMessages = replay.scanned;
    report.recoveredMessages = replay.recovered;
    report.steps.replay = 'ok';
    diag.push('replay', 'success', `replay complete: ${replay.recovered}/${replay.scanned} recovered`, {
      durationMs: Date.now() - tReplay,
    });
  } catch (e) {
    report.steps.replay = 'error';
    const msg = e instanceof Error ? e.message : String(e);
    report.errors.push(`replay: ${msg}`);
    diag.push('replay', 'error', 'replay failed', { error: msg });
  }

  // 4. Refresh the on-device Keychain snapshot so the new state survives a
  //    WebView wipe.
  const tSnap = Date.now();
  try {
    const ok = await syncKeychainSnapshotFromLocal(userId);
    report.steps.snapshot = ok ? 'ok' : 'skipped';
    diag.push('snapshot', ok ? 'success' : 'info', ok ? 'Keychain snapshot updated' : 'snapshot skipped (no native store)', {
      durationMs: Date.now() - tSnap,
    });
  } catch (e) {
    report.steps.snapshot = 'error';
    const msg = e instanceof Error ? e.message : String(e);
    report.errors.push(`snapshot: ${msg}`);
    diag.push('snapshot', 'error', 'snapshot failed', { error: msg });
  }

  // 5. Push the fresh state to the encrypted server backup (debounced inside).
  const tBack = Date.now();
  try {
    const ok = await syncBackupToServer();
    report.steps.backup = ok ? 'ok' : 'skipped';
    diag.push('backup', ok ? 'success' : 'info', ok ? 'server backup synced' : 'backup skipped (debounced or no keys)', {
      durationMs: Date.now() - tBack,
    });
  } catch (e) {
    report.steps.backup = 'error';
    const msg = e instanceof Error ? e.message : String(e);
    report.errors.push(`backup: ${msg}`);
    diag.push('backup', 'error', 'backup failed', { error: msg });
  }

  report.durationMs = Date.now() - t0;
  report.ok = report.errors.length === 0;
  diag.push('done', report.ok ? 'success' : 'warn', `resync finished in ${report.durationMs}ms`, {
    ok: report.ok,
    errors: report.errors.length,
    recovered: report.recoveredMessages,
  });

  if (diagnostic) {
    report.trace = diag.drain();
    report.replayDetails = replayDetails ?? [];
  }

  logCryptoError({
    severity: report.ok ? 'info' : 'warning',
    context: 'restore',
    errorCode: 'E2EE_RESYNC_DONE',
    errorMessage: `E2EE resync ${report.ok ? 'succeeded' : 'completed with errors'} (${report.recoveredMessages}/${report.scannedMessages} recovered)`,
    metadata: {
      userId,
      deviceId,
      platform,
      recovered: report.recoveredMessages,
      scanned: report.scannedMessages,
      durationMs: report.durationMs,
      steps: report.steps,
      errors: report.errors,
      diagnostic,
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

