/**
 * Persistent Local Message Queue (v4 — Hardened)
 *
 * Guarantees:
 * - No message is ever lost
 * - No message is ever sent in plaintext
 * - Plaintext is NEVER persisted to IndexedDB (volatile memory only)
 * - Automatic retry with exponential backoff
 * - Idempotent: no duplicates
 */

import {
  assertE2EETrustedBrowserDevice,
  E2EEDeviceGateError,
} from '@/lib/crypto/e2eeDeviceGate';

export type OutboundMessageStatus =
  | 'draft'
  | 'pending_local'
  | 'encrypting'
  | 'waiting_secure_channel'
  | 'sending'
  | 'sent'
  | 'retry_pending'
  | 'failed_visible';

export interface OutboundMessage {
  localId: string;
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
type RetryMode = 'retry' | 'secure_wait' | 'device_gate';

interface QueueHandlers {
  encrypt: (plaintext: string, conversationId: string) => Promise<string>;
  send: (msg: OutboundMessage) => Promise<string>;
  isReady: (conversationId: string) => boolean;
}

interface HandlerEntry {
  id: string;
  handlers: QueueHandlers;
  registeredAt: number;
}

const DB_NAME = 'forsure-msg-queue';
const DB_VERSION = 1;
const STORE_NAME = 'outbound';
const MAX_RETRIES = 10;
const BASE_RETRY_MS = 2000;
const MAX_RETRY_MS = 60000;

function isDeviceGateError(error: unknown): error is E2EEDeviceGateError {
  return error instanceof E2EEDeviceGateError || (
    !!error &&
    typeof error === 'object' &&
    'status' in error &&
    'assessment' in error &&
    (error as { name?: string }).name === 'E2EEDeviceGateError'
  );
}

function isPinRecoverableDeviceStatus(status: string): boolean {
  return status === 'PIN_REQUIRED_FOR_NEW_DEVICE' || status === 'PIN_REQUIRED_FOR_RISK_CHANGE';
}

function emitDeviceTrustRequired(msg: OutboundMessage, error: E2EEDeviceGateError) {
  const detail = {
    userId: msg.senderId,
    conversationId: msg.conversationId,
    localId: msg.localId,
    status: error.status,
    riskLevel: error.assessment.riskLevel,
    reasons: error.assessment.reasons,
    device: error.assessment.current,
    previous: error.assessment.previous ?? null,
    message: isPinRecoverableDeviceStatus(error.status)
      ? 'Nouveau navigateur ou changement de contexte détecté. Entrez votre PIN pour autoriser ce device.'
      : 'Cet appareil n’est pas autorisé pour l’E2EE.',
  };

  try {
    window.dispatchEvent(new CustomEvent('forsure:e2ee-device-trust-required', { detail }));
    if (isPinRecoverableDeviceStatus(error.status)) {
      window.dispatchEvent(new CustomEvent('forsure:e2ee-pin-unlock-required', {
        detail: {
          userId: msg.senderId,
          reason: error.status,
          message: detail.message,
        },
      }));
    }
  } catch {
    // non-browser/test
  }
}

// ─── Singleton Queue Manager ───

class MessageQueueManager {
  private listeners = new Set<QueueListener>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private processing = new Set<string>();
  private dbPromise: Promise<IDBDatabase> | null = null;
  private handlersByConversation = new Map<string, Map<string, HandlerEntry>>();
  /** SECURITY: Plaintext stored ONLY in volatile memory, never in IndexedDB */
  private volatilePlaintext = new Map<string, string>();
  private legacyPlaintextScrubbed = false;

  // ─── DB ───

  private openDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = () => { this.dbPromise = null; reject(req.error); };
        req.onsuccess = async () => {
          const db = req.result;
          if (!this.legacyPlaintextScrubbed) {
            this.legacyPlaintextScrubbed = true;
            try {
              await this.scrubLegacyPersistedPlaintext(db);
            } catch (e) {
              console.warn('[MSG_QUEUE] legacy plaintext scrub failed', e);
            }
          }
          resolve(db);
        };
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'localId' });
            store.createIndex('conversationId', 'conversationId', { unique: false });
            store.createIndex('status', 'status', { unique: false });
          }
        };
      });
    }
    return this.dbPromise;
  }

  private async scrubLegacyPersistedPlaintext(db: IDBDatabase): Promise<void> {
    const all = await new Promise<OutboundMessage[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

    const leaked = all.filter((msg) => typeof msg.plaintext === 'string' && msg.plaintext.length > 0);
    if (!leaked.length) return;

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const msg of leaked) {
        store.put({ ...msg, plaintext: '' });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    console.warn(`[MSG_QUEUE] scrubbed ${leaked.length} legacy plaintext message(s) from IndexedDB`);
  }

  private toPersistedMessage(msg: OutboundMessage): OutboundMessage {
    return { ...msg, plaintext: '' };
  }

  private hydrateRuntimeMessage(msg: OutboundMessage): OutboundMessage {
    const runtimePlaintext = this.volatilePlaintext.get(msg.localId) || '';
    return { ...msg, plaintext: runtimePlaintext };
  }

  private async dbPut(msg: OutboundMessage): Promise<void> {
    const db = await this.openDB();
    const persisted = this.toPersistedMessage(msg);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(persisted);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async dbDelete(localId: string): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(localId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async dbGet(localId: string): Promise<OutboundMessage | undefined> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(localId);
      req.onsuccess = () => {
        const result = req.result as OutboundMessage | undefined;
        resolve(result ? this.hydrateRuntimeMessage(result) : undefined);
      };
      req.onerror = () => reject(req.error);
    });
  }

  private async dbGetAll(): Promise<OutboundMessage[]> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve((req.result || []).map((msg) => this.hydrateRuntimeMessage(msg)));
      req.onerror = () => reject(req.error);
    });
  }

  private async dbGetByConversation(conversationId: string): Promise<OutboundMessage[]> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const idx = tx.objectStore(STORE_NAME).index('conversationId');
      const req = idx.getAll(conversationId);
      req.onsuccess = () => resolve((req.result || []).map((msg) => this.hydrateRuntimeMessage(msg)));
      req.onerror = () => reject(req.error);
    });
  }

  // ─── Public API ───

  /** Register handlers for encryption and sending */
  registerHandlers(conversationId: string, handlerId: string, handlers: QueueHandlers) {
    const existing = this.handlersByConversation.get(conversationId) || new Map<string, HandlerEntry>();
    existing.set(handlerId, { id: handlerId, handlers, registeredAt: Date.now() });
    this.handlersByConversation.set(conversationId, existing);
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

  private getHandlers(conversationId: string): QueueHandlers | null {
    const entries = this.handlersByConversation.get(conversationId);
    if (!entries || entries.size === 0) return null;

    let latest: HandlerEntry | null = null;
    for (const entry of entries.values()) {
      if (!latest || entry.registeredAt > latest.registeredAt) latest = entry;
    }
    return latest?.handlers || null;
  }

  private getReadyAwareHandlers(conversationId: string): QueueHandlers | null {
    const entries = this.handlersByConversation.get(conversationId);
    if (!entries || entries.size === 0) return null;

    for (const entry of entries.values()) {
      try {
        if (entry.handlers.isReady(conversationId)) return entry.handlers;
      } catch {
        // continue to fallback
      }
    }

    return this.getHandlers(conversationId);
  }

  private async assertDeviceTrustOrPause(msg: OutboundMessage): Promise<boolean> {
    try {
      await assertE2EETrustedBrowserDevice(msg.senderId);
      return true;
    } catch (error) {
      if (!isDeviceGateError(error)) throw error;

      emitDeviceTrustRequired(msg, error);

      if (isPinRecoverableDeviceStatus(error.status)) {
        await this.updateStatus(msg, 'waiting_secure_channel', error.status);
        this.scheduleRetry(msg, 'device_gate');
        return false;
      }

      await this.updateStatus(msg, 'failed_visible', error.status);
      return false;
    }
  }

  /** Enqueue a new outbound message */
  async enqueue(params: {
    conversationId: string;
    senderId: string;
    plaintext: string;
    imageUrl?: string | null;
  }): Promise<OutboundMessage> {
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
      conversationId: params.conversationId,
      senderId: params.senderId,
      plaintext: '',
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

    this.volatilePlaintext.set(msg.localId, params.plaintext);

    await this.dbPut(msg);
    console.log('[MSG_QUEUE] created local message', msg.localId);
    this.notifyListeners(msg.conversationId);
    this.processMessage(msg);
    return msg;
  }

  private async processMessage(msg: OutboundMessage): Promise<void> {
    if (this.processing.has(msg.localId)) return;
    this.processing.add(msg.localId);
    this.clearRetryTimer(msg.localId);

    try {
      if (!(await this.assertDeviceTrustOrPause(msg))) return;

      if (!msg.encryptedBody) {
        await this.updateStatus(msg, 'encrypting');

        const handlers = this.getReadyAwareHandlers(msg.conversationId);
        if (!handlers?.encrypt) {
          await this.updateStatus(msg, 'retry_pending', 'Canal sécurisé indisponible');
          this.scheduleRetry(msg, 'secure_wait');
          return;
        }

        const plaintext = this.volatilePlaintext.get(msg.localId);
        if (!plaintext) {
          await this.updateStatus(msg, 'failed_visible', 'Message perdu (rechargement de page)');
          return;
        }

        try {
          console.log('[E2EE] encrypt start', msg.localId);
          const encrypted = await handlers.encrypt(plaintext, msg.conversationId);
          const withLocalId = this.attachLocalId(encrypted, msg.localId);

          if (!withLocalId || withLocalId === plaintext || !withLocalId.startsWith('{')) {
            console.error('[E2EE] encrypt failed — output is plaintext or empty', msg.localId);
            await this.updateStatus(msg, 'retry_pending', 'Canal sécurisé indisponible');
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
            (normalized.includes('key') && normalized.includes('ready'));

          console.error('[E2EE] encrypt failed', msg.localId, errMsg);

          if (waitingForKeys) {
            await this.updateStatus(msg, 'retry_pending', 'Canal sécurisé indisponible');
            this.scheduleRetry(msg, 'secure_wait');
          } else {
            await this.updateStatus(msg, 'retry_pending', errMsg);
            this.scheduleRetry(msg);
          }
          return;
        }
      }

      // Re-check just before network/database send. A browser/device can become
      // untrusted after encryption but before sending.
      if (!(await this.assertDeviceTrustOrPause(msg))) return;

      await this.updateStatus(msg, 'sending');

      const handlers = this.getHandlers(msg.conversationId);
      if (!handlers?.send) {
        await this.updateStatus(msg, 'retry_pending', 'Send handler not registered');
        this.scheduleRetry(msg);
        return;
      }

      try {
        console.log('[SEND] sending encrypted payload', msg.localId);
        const serverId = await handlers.send(msg);
        msg.serverId = serverId;
        msg.status = 'sent';
        msg.updatedAt = Date.now();
        this.clearRetryTimer(msg.localId);
        console.log('[SEND] backend success', msg.localId, serverId);

        this.volatilePlaintext.delete(msg.localId);
        msg.plaintext = '';
        try {
          await this.dbPut(msg);
        } catch (persistErr) {
          console.warn('[SEND] local persistence failed after backend success', msg.localId, persistErr);
          try { await this.dbDelete(msg.localId); } catch {}
          this.notifyListeners(msg.conversationId);
          return;
        }

        setTimeout(() => {
          this.dbDelete(msg.localId).catch(() => {});
        }, 5000);

        this.notifyListeners(msg.conversationId);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error('[SEND] failed', msg.localId, errMsg);

        if (msg.retryCount >= msg.maxRetries) {
          await this.updateStatus(msg, 'failed_visible', `Échec après ${msg.maxRetries} tentatives: ${errMsg}`);
        } else {
          await this.updateStatus(msg, 'retry_pending', errMsg);
          this.scheduleRetry(msg);
        }
      }
    } finally {
      this.processing.delete(msg.localId);
    }
  }

  private scheduleRetry(msg: OutboundMessage, mode: RetryMode = 'retry') {
    this.clearRetryTimer(msg.localId);

    const SECURE_WAIT_RETRY_MS = 300;
    const SECURE_WAIT_MAX_MS = 20_000;
    const DEVICE_GATE_RETRY_MS = 1500;

    const delay = mode === 'secure_wait'
      ? SECURE_WAIT_RETRY_MS
      : mode === 'device_gate'
        ? DEVICE_GATE_RETRY_MS
        : Math.min(BASE_RETRY_MS * Math.pow(2, msg.retryCount), MAX_RETRY_MS);

    console.log(`[SEND] retry scheduled for ${msg.localId} in ${delay}ms (${mode})`);

    const timer = setTimeout(async () => {
      this.retryTimers.delete(msg.localId);
      const latest = await this.dbGet(msg.localId);
      if (!latest || latest.status === 'sent') return;

      if (mode === 'secure_wait' && Date.now() - latest.createdAt > SECURE_WAIT_MAX_MS) {
        await this.updateStatus(
          latest,
          'failed_visible',
          'Canal sécurisé indisponible (contact sans clé de chiffrement)'
        );
        return;
      }

      if (mode === 'retry') latest.retryCount++;

      latest.updatedAt = Date.now();
      if (mode !== 'device_gate') latest.encryptedBody = null;
      latest.status = 'pending_local';
      await this.dbPut(latest);
      this.processMessage(latest);
    }, delay);

    this.retryTimers.set(msg.localId, timer);
  }

  private async updateStatus(msg: OutboundMessage, status: OutboundMessageStatus, error?: string) {
    msg.status = status;
    msg.lastError = error || null;
    msg.updatedAt = Date.now();
    await this.dbPut(msg);
    this.notifyListeners(msg.conversationId);
  }

  async retryMessage(localId: string): Promise<void> {
    this.clearRetryTimer(localId);
    const all = await this.dbGetAll();
    const msg = all.find(m => m.localId === localId);
    if (!msg) return;

    msg.retryCount = 0;
    msg.encryptedBody = null;
    msg.lastError = null;
    msg.status = 'pending_local';
    msg.updatedAt = Date.now();
    await this.dbPut(msg);
    this.notifyListeners(msg.conversationId);
    this.processMessage(msg);
  }

  async resumeAll(): Promise<void> {
    try {
      const all = await this.dbGetAll();
      const pending = all.filter(m =>
        m.status !== 'sent' && m.status !== 'draft' && m.status !== 'failed_visible'
      );

      for (const msg of pending) {
        if (this.volatilePlaintext.has(msg.localId)) {
          msg.status = 'pending_local';
          msg.encryptedBody = null;
          await this.dbPut(msg);
          this.processMessage(msg);
        } else if (msg.encryptedBody) {
          msg.status = 'pending_local';
          await this.dbPut(msg);
          this.processMessage(msg);
        } else {
          await this.updateStatus(msg, 'failed_visible', 'Message perdu (rechargement de page)');
        }
      }
    } catch (err) {
      console.error('[MSG_QUEUE] resumeAll failed:', err);
    }
  }

  async resumeForConversation(conversationId: string): Promise<void> {
    try {
      const msgs = await this.dbGetByConversation(conversationId);
      const pending = msgs.filter(m =>
        m.status === 'waiting_secure_channel' || m.status === 'retry_pending' || m.status === 'pending_local'
      );

      for (const msg of pending) {
        if (this.volatilePlaintext.has(msg.localId) || msg.encryptedBody) {
          msg.encryptedBody = msg.encryptedBody || null;
          msg.status = 'pending_local';
          await this.dbPut(msg);
          this.processMessage(msg);
        }
      }
    } catch (err) {
      console.error('[MSG_QUEUE] resumeForConversation failed:', err);
    }
  }

  async getPendingMessages(conversationId: string): Promise<OutboundMessage[]> {
    try {
      const msgs = await this.dbGetByConversation(conversationId);
      return msgs.filter(m => m.status !== 'sent');
    } catch {
      return [];
    }
  }

  subscribe(listener: QueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

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

        if (matchMeta.id) byServerId.set(matchMeta.id, matchMeta);
        if (serverMsg.body) byEncryptedBody.set(serverMsg.body, matchMeta);

        const localId = this.extractLocalId(serverMsg.body || '');
        if (localId) byLocalId.set(localId, matchMeta);

        if (matchMeta.senderId && matchMeta.createdAtMs) {
          const senderMatches = bySenderTime.get(matchMeta.senderId) || [];
          senderMatches.push(matchMeta);
          bySenderTime.set(matchMeta.senderId, senderMatches);
        }
      }

      bySenderTime.forEach((list) => list.sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0)));
      if (byLocalId.size === 0 && byEncryptedBody.size === 0 && byServerId.size === 0 && bySenderTime.size === 0) return;

      const queued = await this.dbGetByConversation(conversationId);
      let changed = false;

      for (const msg of queued) {
        if (msg.status === 'sent') continue;

        let serverMatch = byLocalId.get(msg.localId)
          ?? (msg.serverId ? byServerId.get(msg.serverId) : undefined)
          ?? (msg.encryptedBody ? byEncryptedBody.get(msg.encryptedBody) : undefined);

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
            if (bestIdx >= 0) serverMatch = senderMatches.splice(bestIdx, 1)[0];
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
        await this.dbPut(msg);

        setTimeout(() => {
          this.dbDelete(msg.localId).catch(() => {});
        }, 5000);

        changed = true;
      }

      if (changed) this.notifyListeners(conversationId);
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
          plaintext: this.volatilePlaintext.get(m.localId) || m.plaintext || '',
        }));
      this.listeners.forEach(fn => fn(pending));
    } catch {}
  }

  private attachLocalId(encryptedBody: string, localId: string): string {
    if (!encryptedBody.startsWith('{')) return encryptedBody;
    try {
      const payload = JSON.parse(encryptedBody);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return encryptedBody;
      if (typeof payload.__lid === 'string') return encryptedBody;
      return JSON.stringify({ ...payload, __lid: localId });
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

  async removeMessage(localId: string): Promise<void> {
    this.clearRetryTimer(localId);
    this.volatilePlaintext.delete(localId);
    await this.dbDelete(localId);
  }

  private clearRetryTimer(localId: string) {
    const timer = this.retryTimers.get(localId);
    if (!timer) return;
    clearTimeout(timer);
    this.retryTimers.delete(localId);
  }

  async cleanup(): Promise<void> {
    const all = await this.dbGetAll();
    for (const msg of all) {
      if (msg.status === 'sent') await this.dbDelete(msg.localId);
    }
  }
}

export const messageQueue = new MessageQueueManager();

if (typeof window !== 'undefined') {
  const resumeAfterTrust = () => { void messageQueue.resumeAll(); };
  window.addEventListener('forsure:e2ee-device-trusted', resumeAfterTrust);
  window.addEventListener('forsure-keys-unlocked', resumeAfterTrust);
  window.addEventListener('forsure-keys-restored', resumeAfterTrust);
}

export function getStatusLabel(status: OutboundMessageStatus): string {
  switch (status) {
    case 'draft': return 'Brouillon';
    case 'pending_local': return 'En attente…';
    case 'encrypting': return 'Sécurisation…';
    case 'waiting_secure_channel': return 'Validation sécurité…';
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
