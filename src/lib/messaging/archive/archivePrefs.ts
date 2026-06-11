/**
 * Archive backup preference — user-facing toggle for the conversation-level
 * encrypted history backup. Default: ON (stability first). When OFF, no
 * archive_body is written and forward secrecy stays strict.
 *
 * Persisted in localStorage; cross-tab via storage event + window event.
 */
const KEY = 'forsure:archive-backup-enabled:v1';
const EVT = 'forsure:archive-backup-changed';

export function isArchiveBackupEnabled(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v === null) return true; // default ON
    return v === '1';
  } catch {
    return true;
  }
}

export function setArchiveBackupEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, enabled ? '1' : '0');
  } catch {
    /* swallow */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVT, { detail: { enabled } }));
  } catch {
    /* swallow */
  }
}

export function onArchiveBackupChange(cb: (enabled: boolean) => void): () => void {
  const handler = (ev: Event) => {
    const detail = (ev as CustomEvent).detail || {};
    cb(!!(detail as any).enabled);
  };
  const storageHandler = (ev: StorageEvent) => {
    if (ev.key === KEY) cb(isArchiveBackupEnabled());
  };
  window.addEventListener(EVT, handler);
  window.addEventListener('storage', storageHandler);
  return () => {
    window.removeEventListener(EVT, handler);
    window.removeEventListener('storage', storageHandler);
  };
}
