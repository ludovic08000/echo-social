import { ensureOwnReceivingKeysPublished } from '@/lib/crypto/autoKeyProvisioning';

let installed = false;
let lastRepairAt = 0;
const REPAIR_COOLDOWN_MS = 10_000;

function isRecoverableSpkOrRatchetLoss(args: unknown[]): boolean {
  const text = args.map((a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ').toLowerCase();

  return (
    text.includes('spk') && text.includes('not found locally') ||
    text.includes('signed prekey may have been rotated') ||
    text.includes('missing_local_state') ||
    text.includes('responder_rebootstrap') ||
    text.includes('ratchet local purgé') ||
    text.includes('ratchet responder init failed')
  );
}

async function requestRepair(userId: string, reason: string) {
  const now = Date.now();
  if (now - lastRepairAt < REPAIR_COOLDOWN_MS) return;
  lastRepairAt = now;

  try {
    console.warn('[E2EE-GUARD] recoverable local SPK/ratchet loss detected — refreshing local receiving keys', { reason });
    await ensureOwnReceivingKeysPublished(userId);
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', { detail: { userId, reason } }));
    window.dispatchEvent(new CustomEvent('forsure-keys-restored', { detail: { userId, reason } }));
  } catch (e) {
    console.warn('[E2EE-GUARD] repair failed', e);
  }
}

/**
 * Safety guards for web/PWA storage loss.
 *
 * Web browsers can clear IndexedDB/SecureStore while the server still advertises
 * an older SPK. In that state the app must not purge ratchets in a loop or make
 * messages disappear. The safe behavior is:
 * - keep local message/ratchet data intact;
 * - refresh own SPK/OPK material;
 * - retry decrypt/send when realtime catches up.
 */
export function installE2EESafetyGuards(userId: string) {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    if (isRecoverableSpkOrRatchetLoss(args)) {
      void requestRepair(userId, 'console.warn:recoverable_spk_or_ratchet_loss');
    }
  };

  console.error = (...args: unknown[]) => {
    originalError(...args);
    if (isRecoverableSpkOrRatchetLoss(args)) {
      void requestRepair(userId, 'console.error:recoverable_spk_or_ratchet_loss');
    }
  };

  // Last-resort protection: stop the dangerous local ratchet purge loop.
  // We only block deletes against the ratchet state store; all other IndexedDB
  // stores keep their normal behavior.
  try {
    const proto = IDBObjectStore.prototype as IDBObjectStore & { __forsureRatchetGuarded?: boolean };
    if (!proto.__forsureRatchetGuarded) {
      proto.__forsureRatchetGuarded = true;
      const originalDelete = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function guardedDelete(this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
        if (this.name === 'ratchet-states') {
          console.warn('[E2EE-GUARD] blocked ratchet-state delete to prevent message loss', { query: String(query) });
          return this.get(query) as IDBRequest<undefined>;
        }
        return originalDelete.call(this, query);
      };
    }
  } catch (e) {
    originalWarn('[E2EE-GUARD] could not install IndexedDB delete guard', e);
  }
}
