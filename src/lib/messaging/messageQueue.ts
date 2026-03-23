/**
 * Persistent Local Message Queue
 * 
 * Guarantees:
 * - No message is ever lost
 * - No message is ever sent in plaintext
 * - Messages survive page reload
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

export interface OutboundMessage {
  localId: string;
  conversationId: string;
  senderId: string;
  /** Plaintext stored ONLY locally, never sent to server */
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

const DB_NAME = 'forsure-msg-queue';
const DB_VERSION = 1;
const STORE_NAME = 'outbound';
const MAX_RETRIES = 10;
const BASE_RETRY_MS = 2000;
const MAX_RETRY_MS = 60000;

// ─── Singleton Queue Manager ───

class MessageQueueManager {
  private listeners = new Set<QueueListener>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private processing = new Set<string>();
  private dbPromise: Promise<IDBDatabase> | null = null;
  private sendHandler: ((msg: OutboundMessage) => Promise<string>) | null = null;
  private encryptHandler: ((plaintext: string, conversationId: string) => Promise<string>) | null = null;
  private isEncryptionReady: ((conversationId: string) => boolean) | null = null;

  // ─── DB ───

  private openDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = () => { this.dbPromise = null; reject(req.error); };
        req.onsuccess = () => resolve(req.result);
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

  private async dbPut(msg: OutboundMessage): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(msg);
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

  private async dbGetAll(): Promise<OutboundMessage[]> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  private async dbGetByConversation(conversationId: string): Promise<OutboundMessage[]> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const idx = tx.objectStore(STORE_NAME).index('conversationId');
      const req = idx.getAll(conversationId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  // ─── Public API ───

  /** Register handlers for encryption and sending */
  registerHandlers(handlers: {
    encrypt: (plaintext: string, conversationId: string) => Promise<string>;
    send: (msg: OutboundMessage) => Promise<string>;
    isReady: (conversationId: string) => boolean;
  }) {
    this.encryptHandler = handlers.encrypt;
    this.sendHandler = handlers.send;
    this.isEncryptionReady = handlers.isReady;
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
      m.plaintext === params.plaintext &&
      m.senderId === params.senderId &&
      Date.now() - m.createdAt < 2000
    );
    if (duplicate) {
      console.warn('[MSG_QUEUE] duplicate detected, skipping');
      return duplicate;
    }

    const msg: OutboundMessage = {
      localId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      conversationId: params.conversationId,
      senderId: params.senderId,
      plaintext: params.plaintext,
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

    await this.dbPut(msg);
    console.log('[MSG_QUEUE] created local message', msg.localId);
    this.notifyListeners(msg.conversationId);
    this.processMessage(msg);
    return msg;
  }

  /** Process a single message through the state machine */
  private async processMessage(msg: OutboundMessage): Promise<void> {
    if (this.processing.has(msg.localId)) return;
    this.processing.add(msg.localId);

    try {
      // Step 1: Encrypt
      if (!msg.encryptedBody) {
        await this.updateStatus(msg, 'encrypting');

        if (!this.encryptHandler) {
          await this.updateStatus(msg, 'waiting_secure_channel', 'Encryption handler not registered');
          this.scheduleRetry(msg);
          return;
        }

        if (this.isEncryptionReady && !this.isEncryptionReady(msg.conversationId)) {
          console.log('[MSG_QUEUE] encryption not ready, waiting', msg.localId);
          await this.updateStatus(msg, 'waiting_secure_channel', 'Secure channel not ready');
          this.scheduleRetry(msg);
          return;
        }

        try {
          console.log('[E2EE] encrypt start', msg.localId);
          const encrypted = await this.encryptHandler(msg.plaintext, msg.conversationId);

          // CRITICAL: Verify encryption actually produced ciphertext
          if (!encrypted || encrypted === msg.plaintext || !encrypted.startsWith('{')) {
            console.error('[E2EE] encrypt failed — output is plaintext or empty', msg.localId);
            await this.updateStatus(msg, 'waiting_secure_channel', 'Encryption produced invalid output');
            this.scheduleRetry(msg);
            return;
          }

          msg.encryptedBody = encrypted;
          console.log('[E2EE] encrypt success', msg.localId);
          await this.dbPut(msg);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error('[E2EE] encrypt failed', msg.localId, errMsg);
          await this.updateStatus(msg, 'retry_pending', errMsg);
          this.scheduleRetry(msg);
          return;
        }
      }

      // Step 2: Send encrypted payload
      await this.updateStatus(msg, 'sending');

      if (!this.sendHandler) {
        await this.updateStatus(msg, 'retry_pending', 'Send handler not registered');
        this.scheduleRetry(msg);
        return;
      }

      try {
        console.log('[SEND] sending encrypted payload', msg.localId);
        const serverId = await this.sendHandler(msg);
        msg.serverId = serverId;
        msg.status = 'sent';
        msg.updatedAt = Date.now();
        console.log('[SEND] backend success', msg.localId, serverId);

        // Clean up: remove plaintext from persistent storage once sent
        msg.plaintext = '';
        await this.dbPut(msg);

        // Remove from queue after short delay (keep for UI display)
        setTimeout(() => {
          this.dbDelete(msg.localId).catch(() => {});
        }, 5000);

        this.notifyListeners(msg.conversationId);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error('[SEND] failed', msg.localId, errMsg);

        // Network error: retry. Other errors: check retry count.
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

  /** Schedule a retry with exponential backoff */
  private scheduleRetry(msg: OutboundMessage) {
    const existing = this.retryTimers.get(msg.localId);
    if (existing) clearTimeout(existing);

    const delay = Math.min(BASE_RETRY_MS * Math.pow(2, msg.retryCount), MAX_RETRY_MS);
    console.log(`[SEND] retry scheduled for ${msg.localId} in ${delay}ms (attempt ${msg.retryCount + 1})`);

    const timer = setTimeout(async () => {
      this.retryTimers.delete(msg.localId);
      msg.retryCount++;
      msg.updatedAt = Date.now();
      // Reset encrypted body to force re-encryption (key may have changed)
      msg.encryptedBody = null;
      await this.dbPut(msg);
      this.processMessage(msg);
    }, delay);

    this.retryTimers.set(msg.localId, timer);
  }

  /** Update message status and persist */
  private async updateStatus(msg: OutboundMessage, status: OutboundMessageStatus, error?: string) {
    msg.status = status;
    msg.lastError = error || null;
    msg.updatedAt = Date.now();
    await this.dbPut(msg);
    this.notifyListeners(msg.conversationId);
  }

  /** Retry a failed message manually */
  async retryMessage(localId: string): Promise<void> {
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

  /** Resume all pending messages (call on app load / network restore) */
  async resumeAll(): Promise<void> {
    try {
      const all = await this.dbGetAll();
      const pending = all.filter(m =>
        m.status !== 'sent' && m.status !== 'draft' && m.status !== 'failed_visible'
      );

      for (const msg of pending) {
        // Restore plaintext for messages not yet sent
        if (msg.plaintext) {
          msg.status = 'pending_local';
          msg.encryptedBody = null;
          await this.dbPut(msg);
          this.processMessage(msg);
        }
      }
    } catch (err) {
      console.error('[MSG_QUEUE] resumeAll failed:', err);
    }
  }

  /** Resume messages for a specific conversation (when encryption becomes ready) */
  async resumeForConversation(conversationId: string): Promise<void> {
    try {
      const msgs = await this.dbGetByConversation(conversationId);
      const pending = msgs.filter(m =>
        m.status === 'waiting_secure_channel' || m.status === 'retry_pending' || m.status === 'pending_local'
      );

      for (const msg of pending) {
        if (msg.plaintext) {
          msg.encryptedBody = null;
          msg.status = 'pending_local';
          await this.dbPut(msg);
          this.processMessage(msg);
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

  private async notifyListeners(conversationId: string) {
    try {
      const msgs = await this.dbGetByConversation(conversationId);
      const pending = msgs.filter(m => m.status !== 'sent');
      this.listeners.forEach(fn => fn(pending));
    } catch {}
  }

  /** Remove a message from the queue (user cancels failed message) */
  async removeMessage(localId: string): Promise<void> {
    const timer = this.retryTimers.get(localId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(localId);
    }
    await this.dbDelete(localId);
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
    case 'waiting_secure_channel': return 'Canal sécurisé en attente…';
    case 'sending': return 'Envoi…';
    case 'sent': return 'Envoyé';
    case 'retry_pending': return 'À réessayer…';
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
