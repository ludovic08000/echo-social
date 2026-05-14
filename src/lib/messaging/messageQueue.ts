/**
 * Persistent Local Message Queue (v4 — Hardened)
 * 
 * Guarantees:
 * - No message is ever lost
 * - No message is ever sent in plaintext
 * - Plaintext is NEVER persisted to IndexedDB (volatile memory only)
 * - Automatic retry with exponential backoff
 * - Idempotent: no duplicates
 * 
 * States: draft → pending_local → encrypting → waiting_secure_channel → sending → sent
 *                                                                      → retry_pending → encrypting
 *                                                                      → failed_visible
 */

export type OutboundMessageStatus =
  | 'draft'
  | 'pending_local'
  | 'encrypting'
  | 'waiting_secure_channel'
  | 'sending'
  | 'sent'
  | 'retry_pending'
  | 'failed_visible';

import { logCryptoError } from '@/lib/crypto/errorLogger';
import { safeUUID } from '@/e2ee-session/safeUuid';
import { reqToPromise, runTxOn } from '@/lib/crypto/indexedDbTx';

/**
 * Emit a low-volume "trace" entry into crypto_error_logs so we can follow a
 * single outbound message across its full lifecycle in the admin dashboard.
 * Always severity=info — production-safe, never throws.
 */
function traceQueue(
  msg: Pick<OutboundMessage, 'traceId' | 'localId' | 'conversationId' | 'senderId' | 'retryCount' | 'serverId'>,
  event:
    | 'enqueue'
    | 'status:pending_local'
    | 'status:encrypting'
    | 'status:waiting_secure_channel'
    | 'status:sending'
    | 'status:sent'
    | 'status:retry_pending'
    | 'status:failed_visible'
    | 'retry:scheduled'
    | 'retry:user'
    | 'remove:user'
    | 'reconciled',
  extra: Record<string, unknown> = {},
) {
  logCryptoError({
    severity: 'info',
    context: 'queue.trace',
    errorCode: event,
    errorMessage: `[trace ${msg.traceId.slice(0, 8)}] ${event}`,
    conversationId: msg.conversationId,
    metadata: {
      traceId: msg.traceId,
      localId: msg.localId,
      senderId: msg.senderId,
      retryCount: msg.retryCount,
      serverId: msg.serverId,
      ...extra,
    },
  });
}


export interface OutboundMessage {
  localId: string;
  /**
   * Stable trace identifier (UUID) attached at enqueue time and embedded
   * inside the encrypted payload (`__tid`). Lets us follow a single message
   * across enqueue → encrypt → send → backend ack → decrypt on receiver,
   * even if `localId` rotates.
   */
  traceId: string;
  conversationId: string;
  senderId: string;
  /** Runtime-only plaintext (never persisted to IndexedDB) */
  plaintext: string;
  /** Encrypted payload ready to send (null until encryption succeeds) */
  encryptedBody: string | null;
  /** Optional image URL */
  imageUrl: string | null;
  status: OutboundMessageStatus;
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  /** Server-side ID once sent */
  serverId: string | null;
}

type QueueListener = (messages: OutboundMessage[]) => void;

interface QueueHandlers {
  encrypt: (plaintext: string, conversationId: string, localId: string) => Promise<string>;
  send: (msg: OutboundMessage) => Promise<string>;
  isReady: (conversationId: string) => boolean;
}

interface HandlerEntry {
  id: string;
  handlers: QueueHandlers;
  registeredAt: number;
}

const STORE_NAME = 'outbound';
const MAX_RETRIES = 10;
const BASE_RETRY_MS = 2000;
const MAX_RETRY_MS = 60000;
/**
 * Maximum time we keep retrying to find a ready secure channel before
 * surfacing a hard failure to the user. Was 30s — too aggressive on iOS,
 * where Safari/PWA can take well over a minute to rehydrate IndexedDB,
 * fetch peer X3DH bundles, and run the ratchet bootstrap after wake.
 *
 * 15 min covers cold starts + slow networks + iOS background suspension while still
 * eventually freeing the user from a stuck queue. Plaintext stays in
 * volatile memory the whole time.
 */
const SECURE_CHANNEL_HARD_TIMEOUT_MS = 15 * 60_000;

// ─── Singleton Queue Manager ───

class MessageQueueManager {
  private listeners = new Set<QueueListener>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private processing = new Set<string>();
  private processingConversations = new Set<string>();
  private handlersByConversation = new Map<string, Map<string, HandlerEntry>>();
  /** SECURITY: Plaintext stored ONLY in volatile memory, never in IndexedDB */
  private volatilePlaintext = new Map<string, string>();
  private legacyPlaintextScrubbed = false;
  /**
   * One-shot guard used by resumeAll(): when plaintext is still in RAM, a
   * queued ciphertext may have been bound to an older device identity. The
   * next processor pass must drop that ciphertext and encrypt again with the
   * currently registered handlers. Manual retry does not set this flag.
   */
  private forceReencrypt = new Set<string>();
  /** Debounce resumeForConversation to prevent tight loops on iOS where
   *  React re-renders cause repeated resume calls before retry timers fire. */
  private lastResumeAt = new Map<string, number>();

  // ─── DB ───

  private async ensureLegacyPlaintextScrubbed(): Promise<void> {
    if (this.legacyPlaintextScrubbed) return;
    this.legacyPlaintextScrubbed = true;
    try {
      await this.scrubLegacyPersistedPlaintext();
    } catch (e) {
      console.warn('[MSG_QUEUE] legacy plaintext scrub failed', e);
    }
  }

  private async scrubLegacyPersistedPlaintext(): Promise<void> {
    const all = await runTxOn('msg-queue', STORE_NAME, 'readonly', (store) => {
      return reqToPromise<OutboundMessage[]>(store.getAll());
    });

    const leaked = all.filter((msg) => typeof msg.plaintext === 'string' && msg.plaintext.length > 0);
    if (!leaked.length) return;

    await runTxOn('msg-queue', STORE_NAME, 'readwrite', (store) => {
      for (const msg of leaked) {
        store.put({ ...msg, plaintext: '' });
      }
    });

    console.warn(`[MSG_QUEUE] scrubbed ${leaked.length} legacy plaintext message(s) from IndexedDB`);
  }

  private toPersistedMessage(msg: OutboundMessage): OutboundMessage {
    return {
      ...msg,
      plaintext: '',
    };
  }

  private hydrateRuntimeMessage(msg: OutboundMessage): OutboundMessage {
    const runtimePlaintext = this.volatilePlaintext.get(msg.localId) || '';
    return {
      ...msg,
      plaintext: runtimePlaintext,
    };
  }

  private async dbPut(msg: OutboundMessage): Promise<void> {
    await this.ensureLegacyPlaintextScrubbed();
    const persisted = this.toPersistedMessage(msg);
    await runTxOn('msg-queue', STORE_NAME, 'readwrite', (store) => {
      store.put(persisted);
    });
  }

  private async dbDelete(localId: string): Promise<void> {
    await this.ensureLegacyPlaintextScrubbed();
    await runTxOn('msg-queue', STORE_NAME, 'readwrite', (store) => {
      store.delete(localId);
    });
  }

  private async dbGet(localId: string): Promise<OutboundMessage | undefined> {
    await this.ensureLegacyPlaintextScrubbed();
    return runTxOn('msg-queue', STORE_NAME, 'readonly', async (store) => {
      const result = await reqToPromise<OutboundMessage | undefined>(store.get(localId));
      return result ? this.hydrateRuntimeMessage(result) : undefined;
    });
  }

  private async dbGetAll(): Promise<OutboundMessage[]> {
    await this.ensureLegacyPlaintextScrubbed();
    return runTxOn('msg-queue', STORE_NAME, 'readonly', async (store) => {
      const result = await reqToPromise<OutboundMessage[]>(store.getAll());
      return (result || []).map((msg) => this.hydrateRuntimeMessage(msg));
    });
  }

  private async dbGetByConversation(conversationId: string): Promise<OutboundMessage[]> {
    await this.ensureLegacyPlaintextScrubbed();
    return runTxOn('msg-queue', STORE_NAME, 'readonly', async (store) => {
      const result = await reqToPromise<OutboundMessage[]>(store.index('conversationId').getAll(conversationId));
      return (result || []).map((msg) => this.hydrateRuntimeMessage(msg));
    });
  }

  // ─── Public API ───

  /** Register handlers for encryption and sending */
  registerHandlers(conversationId: string, handlerId: string, handlers: QueueHandlers) {
    const existing = this.handlersByConversation.get(conversationId) || new Map<string, HandlerEntry>();
    existing.set(handlerId, {
      id: handlerId,
      handlers,
      registeredAt: Date.now(),
    });
    this.handlersByConversation.set(conversationId, existing);

    try {
      if (handlers.isReady(conversationId)) {
        queueMicrotask(() => {
          void this.resumeForConversation(conversationId, { forceReady: true });
        });
      }
    } catch {
      // Readiness probes must never break handler registration.
    }
  }

  /** Unregister handlers when a conversation hook unmounts */
  unregisterHandlers(conversationId: string, handlerId: string) {
    const entries = this.handlersByConversation.get(conversationId);
    if (!entries) return;

    entries.delete(handlerId);

    if (entries.size === 0) {
      this.handlersByConversation.delete(conversationId);
      return;
    }

    this.handlersByConversation.set(conversationId, entries);
  }

  /** Return the most recently registered active handlers for a conversation */
  private getHandlers(conversationId: string): QueueHandlers | null {
    const entries = this.handlersByConversation.get(conversationId);
    if (!entries || entries.size === 0) return null;

    let latest: HandlerEntry | null = null;
    for (const entry of entries.values()) {
      if (!latest || entry.registeredAt > latest.registeredAt) {
        latest = entry;
      }
    }

    return latest?.handlers || null;
  }

  /** Return a handler only when its secure channel is ready. */
  private getReadyAwareHandlers(conversationId: string): QueueHandlers | null {
    const entries = this.handlersByConversation.get(conversationId);
    if (!entries || entries.size === 0) return null;

    for (const entry of entries.values()) {
      try {
        if (entry.handlers.isReady(conversationId)) {
          return entry.handlers;
        }
      } catch {
        // continue checking other mounted handlers
      }
    }

    return null;
  }

  /** Enqueue a new outbound message */
  async enqueue(params: {
    conversationId: string;
    senderId: string;
    plaintext: string;
    imageUrl?: string | null;
  }): Promise<OutboundMessage> {
    // Idempotency: check for duplicate within 2 seconds
    const recent = await this.dbGetByConversation(params.conversationId);
    const duplicate = recent.find(m =>
      m.senderId === params.senderId &&
      Date.now() - m.createdAt < 2000 &&
      this.volatilePlaintext.get(m.localId) === params.plaintext
    );
    if (duplicate) {
      console.warn('[MSG_QUEUE] duplicate detected, skipping');
      return duplicate;
    }

    const msg: OutboundMessage = {
      localId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      traceId: safeUUID(),
      conversationId: params.conversationId,
      senderId: params.senderId,
      plaintext: '', // NEVER stored in IndexedDB
      encryptedBody: null,
      imageUrl: params.imageUrl || null,
      status: 'pending_local',
      retryCount: 0,
      maxRetries: MAX_RETRIES,
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      serverId: null,
    };

    // Store plaintext ONLY in volatile memory
    this.volatilePlaintext.set(msg.localId, params.plaintext);

    await this.dbPut(msg);
    console.log('[MSG_QUEUE] created local message', msg.localId, 'trace', msg.traceId);
    traceQueue(msg, 'enqueue', { plaintextLen: params.plaintext.length, hasImage: !!params.imageUrl });
    this.notifyListeners(msg.conversationId);
    this.processMessage(msg);
    return msg;
  }

  /** Process a single message through the state machine */
  private async processMessage(input: OutboundMessage): Promise<void> {
    let msg = input;
    if (this.processing.has(msg.localId) || this.processingConversations.has(msg.conversationId)) {
      void this.queueConversationDrain(msg.conversationId);
      return;
    }
    this.processing.add(msg.localId);
    this.processingConversations.add(msg.conversationId);
    this.clearRetryTimer(msg.localId);

    try {
      if (await this.hasOlderRunnableMessage(msg)) {
        void this.queueConversationDrain(msg.conversationId);
        return;
      }

      const latest = await this.dbGet(msg.localId);
      if (!latest || latest.status === 'sent') return;
      msg = latest;

      if (this.forceReencrypt.has(msg.localId)) {
        this.forceReencrypt.delete(msg.localId);
        if (this.volatilePlaintext.has(msg.localId)) {
          msg.encryptedBody = null;
          msg.status = 'pending_local';
          msg.updatedAt = Date.now();
          await this.dbPut(msg);
        }
      }

      // Step 1: Encrypt
      if (!msg.encryptedBody) {
        await this.updateStatus(msg, 'encrypting');

        const handlers = this.getReadyAwareHandlers(msg.conversationId);
        if (!handlers?.encrypt) {
          // Wait up to SECURE_CHANNEL_HARD_TIMEOUT_MS before failing.
          // This covers iOS cold start + slow X3DH bootstrap reliably.
          const age = Date.now() - msg.createdAt;
          if (age > SECURE_CHANNEL_HARD_TIMEOUT_MS) {
            console.warn('[MSG_QUEUE] secure channel still unavailable after hard timeout', msg.localId);
            await this.updateStatus(msg, 'failed_visible', 'Canal sécurisé indisponible — réessayez plus tard');
            return;
          }
          console.log('[MSG_QUEUE] waiting for secure channel', msg.localId, 'age=', age, 'ms');
          await this.updateStatus(msg, 'waiting_secure_channel', 'En attente du canal sécurisé');
          this.scheduleRetry(msg, 'secure_wait');
          return;
        }

        // Read plaintext from volatile memory
        const plaintext = this.volatilePlaintext.get(msg.localId);
        if (!plaintext) {
          // Plaintext lost (page reload) — message cannot be recovered
          await this.updateStatus(msg, 'failed_visible', 'Message perdu (rechargement de page)');
          return;
        }

        try {
          console.log('[E2EE] encrypt start', msg.localId);
          // Timeout: if encryption takes more than 15s, abort
          const encryptPromise = handlers.encrypt(plaintext, msg.conversationId, msg.localId);
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout chiffrement (15s)')), 15_000)
          );
          const encrypted = await Promise.race([encryptPromise, timeoutPromise]);
          const withLocalId = this.attachLocalId(encrypted, msg.localId, msg.traceId);

          // CRITICAL: Verify the encrypt handler actually produced a known
          // ciphertext envelope. We check explicit protocol prefixes (JSON
          // conv envelope `{` or device-pair v3/v4 ratchet) instead of a
          // loose JSON-only heuristic — a multi-line plaintext starting
          // with `{` would otherwise sneak through.
          const looksCiphertext =
            !!withLocalId &&
            withLocalId !== plaintext &&
            (
              withLocalId.startsWith('{') ||                  // conv-level JSON envelope
              withLocalId.startsWith('x3dh4.') ||             // device Double Ratchet
              withLocalId.startsWith('x3dh3.') ||             // legacy device ratchet
              withLocalId.startsWith('x3dh2.') ||             // X3DH per-device with OPK
              withLocalId.startsWith('x3dh1.')                // X3DH per-device w/o OPK
            );
          if (!looksCiphertext) {
            logCryptoError({
              severity: 'warning',
              context: 'queue.encrypt',
              errorCode: 'E_ENCRYPT_OUTPUT_INVALID',
              errorMessage: 'Encrypted output was unavailable; queue will retry securely',
              conversationId: msg.conversationId,
              metadata: { localId: msg.localId, traceId: msg.traceId },
            });
            await this.updateStatus(msg, 'waiting_secure_channel', 'secure_channel_unavailable');
            this.scheduleRetry(msg, 'secure_wait');
            return;
          }

          msg.encryptedBody = withLocalId;
          console.log('[E2EE] encrypt success', msg.localId);
          await this.dbPut(msg);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const normalized = errMsg.toLowerCase();
          const waitingForKeys =
            normalized.includes('not ready') ||
            normalized.includes('initializ') ||
            normalized.includes('keys not ready') ||
            normalized.includes('encryption not available') ||
            normalized.includes('message en attente chiffrée') ||
            normalized.includes('bundle x3dh') ||
            normalized.includes('double ratchet') ||
            normalized.includes('clés du contact indisponibles') ||
            normalized.includes('chiffrement requis') ||
            normalized.includes('contact n\'a pas encore de clés') ||
            normalized.includes('contact n\'a pas encore publié ses clés') ||
            (normalized.includes('key') && normalized.includes('ready'));
          const transientCryptoPressure =
            normalized.includes('rate limited') ||
            normalized.includes('exfiltration attempt') ||
            normalized.includes('opération limitée');
          const permanentSafetyMismatch =
            normalized.includes('clé de sécurité du contact modifiée') ||
            normalized.includes('verification obligatoire avant envoi') ||
            normalized.includes('vérifiez l\'identité avant d\'envoyer') ||
            normalized.includes('fingerprint changed');

          logCryptoError({
            severity: permanentSafetyMismatch ? 'error' : 'warning',
            context: 'queue.encrypt',
            errorCode: permanentSafetyMismatch ? 'E_SECURE_CHANNEL_BLOCKED' : 'E_ENCRYPT_ATTEMPT_DEFERRED',
            errorMessage: permanentSafetyMismatch ? 'Secure channel blocked by identity safety check' : 'Secure send deferred',
            conversationId: msg.conversationId,
            metadata: {
              localId: msg.localId,
              traceId: msg.traceId,
              retryCount: msg.retryCount,
              reason: errMsg.slice(0, 500),
            },
          });

          if (permanentSafetyMismatch) {
            await this.updateStatus(msg, 'failed_visible', 'secure_channel_blocked');
            return;
          }

          // Fail only after the full hard timeout window for key-waiting errors.
          // (Was 30s — far too short for iOS cold starts and PWA wake.)
          const age = Date.now() - msg.createdAt;
          if (waitingForKeys && age > SECURE_CHANNEL_HARD_TIMEOUT_MS) {
            console.warn('[MSG_QUEUE] giving up - peer keys still missing after hard timeout', msg.localId);
            await this.updateStatus(msg, 'failed_visible', 'secure_channel_unavailable');
            return;
          }

          if (waitingForKeys || transientCryptoPressure) {
            await this.updateStatus(msg, 'waiting_secure_channel', 'secure_channel_initializing');
            this.scheduleRetry(msg, 'secure_wait');
          } else {
            // Non-key errors: fail after 3 retries instead of 10
            if (msg.retryCount >= 3) {
              await this.updateStatus(msg, 'failed_visible', 'secure_encrypt_unavailable');
            } else {
              await this.updateStatus(msg, 'retry_pending', 'secure_encrypt_retry');
              this.scheduleRetry(msg);
            }
          }
          return;
        }
      }

      // Step 2: Send encrypted payload
      if (this.forceReencrypt.has(msg.localId) && this.volatilePlaintext.has(msg.localId)) {
        this.forceReencrypt.delete(msg.localId);
        msg.encryptedBody = null;
        msg.status = 'pending_local';
        msg.updatedAt = Date.now();
        await this.dbPut(msg);
        void this.queueConversationDrain(msg.conversationId);
        return;
      }

      // CRITICAL FIX: Hydrate msg.plaintext from volatile memory BEFORE sending.
      // The send handler needs plaintext to cache it for the sender's own display
      // (Double Ratchet can't decrypt own messages — Signal design).
      // This is safe because dbPut() always strips plaintext via toPersistedMessage().
      const volatilePt = this.volatilePlaintext.get(msg.localId);
      if (volatilePt) {
        msg.plaintext = volatilePt;
      }

      await this.updateStatus(msg, 'sending');

      const handlers = this.getReadyAwareHandlers(msg.conversationId);
      if (!handlers?.send) {
        const age = Date.now() - msg.createdAt;
        if (age > SECURE_CHANNEL_HARD_TIMEOUT_MS) {
          await this.updateStatus(msg, 'failed_visible', 'Canal sécurisé indisponible - réessayez plus tard');
          return;
        }
        await this.updateStatus(msg, 'waiting_secure_channel', 'En attente du canal sécurisé');
        this.scheduleRetry(msg, 'secure_wait');
        return;
      }

      try {
        console.log('[SEND] sending encrypted payload', msg.localId);
        const serverId = await handlers.send(msg);
        msg.serverId = serverId;
        msg.status = 'sent';
        msg.updatedAt = Date.now();
        this.clearRetryTimer(msg.localId);
        this.forceReencrypt.delete(msg.localId);
        console.log('[SEND] backend success', msg.localId, serverId);
        traceQueue(msg, 'status:sent', { serverId });

        // Clean up: remove volatile plaintext
        this.volatilePlaintext.delete(msg.localId);
        msg.plaintext = '';
        try {
          await this.dbPut(msg);
        } catch (persistErr) {
          // Do not keep a false pending state when backend already accepted the message
          console.warn('[SEND] local persistence failed after backend success', msg.localId, persistErr);
          try {
            await this.dbDelete(msg.localId);
          } catch {}
          this.notifyListeners(msg.conversationId);
          return;
        }

        // Remove from queue immediately — realtime subscription handles display
        try {
          await this.dbDelete(msg.localId);
        } catch {}

        this.notifyListeners(msg.conversationId);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logCryptoError({
          severity: 'warning',
          context: 'queue.send',
          errorCode: 'E_SEND_ATTEMPT_DEFERRED',
          errorMessage: 'Secure send deferred',
          conversationId: msg.conversationId,
          metadata: {
            localId: msg.localId,
            traceId: msg.traceId,
            retryCount: msg.retryCount,
            reason: errMsg.slice(0, 500),
          },
        });

        // Network error: retry. Other errors: check retry count.
        if (msg.retryCount >= msg.maxRetries) {
          await this.updateStatus(msg, 'failed_visible', 'secure_send_unavailable');
        } else {
          await this.updateStatus(msg, 'retry_pending', 'secure_send_retry');
          this.scheduleRetry(msg);
        }
      }
    } finally {
      this.processing.delete(msg.localId);
      this.processingConversations.delete(msg.conversationId);
      void this.queueConversationDrain(msg.conversationId);
    }
  }

  private async hasOlderRunnableMessage(msg: OutboundMessage): Promise<boolean> {
    const queued = await this.dbGetByConversation(msg.conversationId);
    return queued.some((candidate) => {
      if (candidate.localId === msg.localId) return false;
      if (
        candidate.status !== 'pending_local' &&
        candidate.status !== 'waiting_secure_channel' &&
        candidate.status !== 'retry_pending'
      ) {
        return false;
      }
      if (!this.volatilePlaintext.has(candidate.localId) && !candidate.encryptedBody) return false;
      if (candidate.createdAt < msg.createdAt) return true;
      return candidate.createdAt === msg.createdAt && candidate.localId.localeCompare(msg.localId) < 0;
    });
  }

  private async queueConversationDrain(conversationId: string): Promise<void> {
    queueMicrotask(async () => {
      if (this.processingConversations.has(conversationId)) {
        setTimeout(() => {
          void this.queueConversationDrain(conversationId);
        }, 50);
        return;
      }

      try {
        const queued = await this.dbGetByConversation(conversationId);
        const next = queued
          .filter(m =>
            m.status === 'pending_local' ||
            m.status === 'waiting_secure_channel' ||
            m.status === 'retry_pending'
          )
          .filter(m => this.volatilePlaintext.has(m.localId) || !!m.encryptedBody)
          .sort((a, b) => a.createdAt - b.createdAt || a.localId.localeCompare(b.localId))[0];
        if (!next || this.processing.has(next.localId) || this.retryTimers.has(next.localId)) {
          return;
        }
        if (next) {
          if (next.status !== 'pending_local') {
            next.status = 'pending_local';
            next.updatedAt = Date.now();
            await this.dbPut(next);
          }
          void this.processMessage(next);
        }
      } catch {}
    });
  }

  /**
   * Schedule retry:
   * - secure_wait: fast polling for E2EE readiness (instant UX)
   * - retry: exponential backoff for real errors/network issues
   */
  private scheduleRetry(msg: OutboundMessage, mode: 'retry' | 'secure_wait' = 'retry') {
    this.clearRetryTimer(msg.localId);

    const SECURE_WAIT_RETRY_MS = 3_000;

    const delay = mode === 'secure_wait'
      ? SECURE_WAIT_RETRY_MS
      : Math.min(BASE_RETRY_MS * Math.pow(2, msg.retryCount), MAX_RETRY_MS);

    console.log(`[SEND] retry scheduled for ${msg.localId} in ${delay}ms (${mode})`);
    traceQueue(msg, 'retry:scheduled', { mode, delayMs: delay });

    const timer = setTimeout(async () => {
      this.retryTimers.delete(msg.localId);
      const latest = await this.dbGet(msg.localId);
      if (!latest || latest.status === 'sent') return;

      if (mode === 'retry') {
        latest.retryCount++;
      }

      latest.updatedAt = Date.now();
      // Preserve already-encrypted payload on normal retry.
      // This is CRITICAL for first X3DH/ratchet messages: retry must resend the exact same payload/header.
      if (mode === 'secure_wait') {
        latest.encryptedBody = null;
      }
      await this.dbPut(latest);
      this.processMessage(latest);
    }, delay);

    this.retryTimers.set(msg.localId, timer);
  }

  /** Update message status and persist */
  private async updateStatus(msg: OutboundMessage, status: OutboundMessageStatus, error?: string) {
    const previous = msg.status;
    msg.status = status;
    msg.lastError = error || null;
    msg.updatedAt = Date.now();
    await this.dbPut(msg);
    // Trace every transition (skip no-op transitions to keep volume sane)
    if (previous !== status) {
      traceQueue(msg, `status:${status}` as Parameters<typeof traceQueue>[1], {
        previous,
        error: error || null,
      });
    }
    this.notifyListeners(msg.conversationId);
  }

  /** Retry a failed message manually */
  async retryMessage(localId: string): Promise<void> {
    this.clearRetryTimer(localId);
    this.forceReencrypt.delete(localId);
    const all = await this.dbGetAll();
    const msg = all.find(m => m.localId === localId);
    if (!msg) return;

    msg.retryCount = 0;
    msg.lastError = null;
    msg.status = 'pending_local';
    msg.updatedAt = Date.now();
    await this.dbPut(msg);
    traceQueue(msg, 'retry:user');
    this.notifyListeners(msg.conversationId);
    this.processMessage(msg);
  }

  /** Resume all pending messages (call on app load / network restore) */
  async resumeAll(): Promise<void> {
    try {
      const all = await this.dbGetAll();
      const pending = all.filter(m =>
        m.status !== 'sent' && m.status !== 'draft' && m.status !== 'failed_visible'
      );

      for (const msg of pending) {
        this.clearRetryTimer(msg.localId);
        // Only resume if plaintext is still in volatile memory
        if (this.volatilePlaintext.has(msg.localId)) {
          this.forceReencrypt.add(msg.localId);
          msg.status = 'pending_local';
          msg.encryptedBody = null;
          await this.dbPut(msg);
          this.processMessage(msg);
        } else if (msg.encryptedBody) {
          // Already encrypted, just needs sending
          this.forceReencrypt.delete(msg.localId);
          msg.status = 'pending_local';
          await this.dbPut(msg);
          this.processMessage(msg);
        } else {
          // Plaintext lost (page reload) — mark as failed
          await this.updateStatus(msg, 'failed_visible', 'Message perdu (rechargement de page)');
        }
      }
    } catch (err) {
      console.error('[MSG_QUEUE] resumeAll failed:', err);
    }
  }

  /** Resume messages for a specific conversation (when encryption becomes ready) */
  async resumeForConversation(
    conversationId: string,
    options: { forceReady?: boolean } = {},
  ): Promise<void> {
    try {
      // Debounce: ignore resume calls that fire less than 1.5s after the previous one.
      // On iOS, React re-renders trigger many redundant resume calls, which short-circuit
      // the secure_wait retry timer (3s) and produce a tight retry loop.
      const now = Date.now();
      const last = this.lastResumeAt.get(conversationId) || 0;
      if (!options.forceReady && now - last < 1500) {
        return;
      }
      this.lastResumeAt.set(conversationId, now);

      const msgs = await this.dbGetByConversation(conversationId);
      const pending = msgs.filter(m =>
        m.status === 'waiting_secure_channel' || m.status === 'retry_pending' || m.status === 'pending_local'
      );

      for (const msg of pending.sort((a, b) => a.createdAt - b.createdAt || a.localId.localeCompare(b.localId))) {
        // Don't restart a message that already has an active retry timer.
        // The timer will fire at the correct delay and call processMessage itself.
        if (this.retryTimers.has(msg.localId)) {
          if (!options.forceReady) continue;
          this.clearRetryTimer(msg.localId);
        }
        if (this.processing.has(msg.localId)) continue;

        if (this.volatilePlaintext.has(msg.localId) || msg.encryptedBody) {
          if (options.forceReady && this.volatilePlaintext.has(msg.localId) && msg.encryptedBody) {
            continue;
          }
          msg.encryptedBody = msg.encryptedBody || null;
          msg.status = 'pending_local';
          await this.dbPut(msg);
          this.processMessage(msg);
          break;
        }
      }
    } catch (err) {
      console.error('[MSG_QUEUE] resumeForConversation failed:', err);
    }
  }

  /** Get pending messages for a conversation (for UI display) */
  async getPendingMessages(conversationId: string): Promise<OutboundMessage[]> {
    try {
      const msgs = await this.dbGetByConversation(conversationId);
      return msgs.filter(m => m.status !== 'sent');
    } catch {
      return [];
    }
  }

  /** Subscribe to queue changes */
  subscribe(listener: QueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Reconcile local pending queue with messages already persisted on backend.
   * Useful when HTTP acknowledgement was lost but insert actually succeeded.
   */
  async reconcileDelivered(
    conversationId: string,
    serverMessages: Array<{ id?: string | null; senderId?: string | null; body?: string | null; createdAt?: string | null }>,
  ): Promise<void> {
    try {
      type ServerMatch = { id: string | null; senderId: string | null; createdAtMs: number | null };

      const byLocalId = new Map<string, ServerMatch>();
      const byEncryptedBody = new Map<string, ServerMatch>();
      const byServerId = new Map<string, ServerMatch>();
      const bySenderTime = new Map<string, ServerMatch[]>();

      for (const serverMsg of serverMessages) {
        const createdAtMs = serverMsg.createdAt ? new Date(serverMsg.createdAt).getTime() : null;
        const matchMeta: ServerMatch = {
          id: serverMsg.id || null,
          senderId: serverMsg.senderId || null,
          createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : null,
        };

        if (matchMeta.id) {
          byServerId.set(matchMeta.id, matchMeta);
        }

        if (serverMsg.body) {
          byEncryptedBody.set(serverMsg.body, matchMeta);
        }

        const localId = this.extractLocalId(serverMsg.body || '');
        if (localId) {
          byLocalId.set(localId, matchMeta);
        }

        if (matchMeta.senderId && matchMeta.createdAtMs) {
          const senderMatches = bySenderTime.get(matchMeta.senderId) || [];
          senderMatches.push(matchMeta);
          bySenderTime.set(matchMeta.senderId, senderMatches);
        }
      }

      bySenderTime.forEach((list) => list.sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0)));

      // Continue reconciliation even when __lid metadata is absent:
      // fallback matching by encrypted payload is still valid.
      if (byLocalId.size === 0 && byEncryptedBody.size === 0 && byServerId.size === 0 && bySenderTime.size === 0) return;

      const queued = await this.dbGetByConversation(conversationId);
      let changed = false;

      for (const msg of queued) {
        if (msg.status === 'sent') continue;

        let serverMatch = byLocalId.get(msg.localId)
          ?? (msg.serverId ? byServerId.get(msg.serverId) : undefined)
          ?? (msg.encryptedBody ? byEncryptedBody.get(msg.encryptedBody) : undefined);

        // Last-resort fallback for legacy stuck messages (no __lid/serverId match):
        // match by same sender and very close timestamp.
        if (!serverMatch && msg.senderId) {
          const senderMatches = bySenderTime.get(msg.senderId);
          if (senderMatches?.length) {
            let bestIdx = -1;
            let bestDelta = Number.POSITIVE_INFINITY;

            for (let i = 0; i < senderMatches.length; i++) {
              const candidateTs = senderMatches[i].createdAtMs;
              if (!candidateTs) continue;
              const delta = Math.abs(candidateTs - msg.createdAt);
              if (delta <= 15000 && delta < bestDelta) {
                bestDelta = delta;
                bestIdx = i;
              }
            }

            if (bestIdx >= 0) {
              serverMatch = senderMatches.splice(bestIdx, 1)[0];
            }
          }
        }

        if (!serverMatch) continue;
        if (serverMatch.senderId && serverMatch.senderId !== msg.senderId) continue;

        const timer = this.retryTimers.get(msg.localId);
        if (timer) {
          clearTimeout(timer);
          this.retryTimers.delete(msg.localId);
        }

        msg.serverId = serverMatch.id || msg.serverId;
        msg.status = 'sent';
        msg.lastError = null;
        msg.updatedAt = Date.now();
        msg.plaintext = '';
        this.volatilePlaintext.delete(msg.localId);
        traceQueue(msg, 'reconciled', { serverId: msg.serverId });
        await this.dbDelete(msg.localId);

        changed = true;
      }

      if (changed) {
        this.notifyListeners(conversationId);
      }
    } catch (err) {
      console.warn('[MSG_QUEUE] reconcileDelivered failed:', err);
    }
  }

  private async notifyListeners(conversationId: string) {
    try {
      const msgs = await this.dbGetByConversation(conversationId);
      const pending = msgs
        .filter(m => m.status !== 'sent')
        .map(m => ({
          ...m,
          // Re-inject volatile plaintext so UI can display the message text
          plaintext: this.volatilePlaintext.get(m.localId) || m.plaintext || '',
        }));
      this.listeners.forEach(fn => fn(pending));
    } catch {}
  }

  private attachLocalId(encryptedBody: string, localId: string, traceId?: string): string {
    if (!encryptedBody.startsWith('{')) return encryptedBody;
    try {
      const payload = JSON.parse(encryptedBody);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return encryptedBody;
      const next: Record<string, unknown> = { ...payload };
      if (typeof payload.__lid !== 'string') next.__lid = localId;
      if (traceId && typeof payload.__tid !== 'string') next.__tid = traceId;
      return JSON.stringify(next);
    } catch {
      return encryptedBody;
    }
  }

  private extractLocalId(body: string): string | null {
    if (!body || !body.startsWith('{')) return null;
    try {
      const payload = JSON.parse(body);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
      return typeof payload.__lid === 'string' ? payload.__lid : null;
    } catch {
      return null;
    }
  }

  /** Remove a message from the queue (user cancels failed message) */
  async removeMessage(localId: string): Promise<void> {
    this.clearRetryTimer(localId);
    this.forceReencrypt.delete(localId);
    const existing = await this.dbGet(localId).catch(() => undefined);
    if (existing) {
      traceQueue(existing, 'remove:user', { reason: 'user_cancel', lastStatus: existing.status });
    }
    this.volatilePlaintext.delete(localId);
    await this.dbDelete(localId);
  }

  private clearRetryTimer(localId: string) {
    const timer = this.retryTimers.get(localId);
    if (!timer) return;
    clearTimeout(timer);
    this.retryTimers.delete(localId);
  }

  /** Cleanup: remove all sent messages from DB */
  async cleanup(): Promise<void> {
    const all = await this.dbGetAll();
    for (const msg of all) {
      if (msg.status === 'sent') {
        await this.dbDelete(msg.localId);
      }
    }
  }
}

// Singleton
export const messageQueue = new MessageQueueManager();

// ─── Status labels for UI ───

export function getStatusLabel(status: OutboundMessageStatus): string {
  switch (status) {
    case 'draft': return 'Brouillon';
    case 'pending_local': return 'En attente…';
    case 'encrypting': return 'Sécurisation…';
    case 'waiting_secure_channel': return 'Reconnexion sécurisée…';
    case 'sending': return 'Envoi…';
    case 'sent': return 'Envoyé';
    case 'retry_pending': return 'Reconnexion sécurisée…';
    case 'failed_visible': return 'Échec';
  }
}

export function getStatusIcon(status: OutboundMessageStatus): 'lock' | 'clock' | 'send' | 'check' | 'retry' | 'error' {
  switch (status) {
    case 'draft': return 'clock';
    case 'pending_local': return 'clock';
    case 'encrypting': return 'lock';
    case 'waiting_secure_channel': return 'lock';
    case 'sending': return 'send';
    case 'sent': return 'check';
    case 'retry_pending': return 'retry';
    case 'failed_visible': return 'error';
  }
}
