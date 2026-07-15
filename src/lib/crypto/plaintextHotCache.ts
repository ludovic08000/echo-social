const STORAGE_KEY = 'forsure:plaintext-hot-cache:v2';
const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ENTRIES = 250;
const MAX_TOTAL_CHARS = 1_500_000;
const MAX_ENTRY_CHARS = 64_000;

interface HotEntry {
  p: string;
  t: number;
}

type HotStore = Record<string, HotEntry>;

const memory = new Map<string, HotEntry>();

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length}:${(hash >>> 0).toString(36)}`;
}

function hotKey(messageId: string | undefined, ciphertextBody: string): string {
  return `${messageId ?? 'noid'}|${fingerprint(ciphertextBody)}`;
}

function readStore(): HotStore {
  try {
    if (typeof sessionStorage === 'undefined') return {};
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as HotStore;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: HotStore): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const cutoff = Date.now() - TTL_MS;
    const entries = Object.entries(store)
      .filter(([, entry]) => Boolean(entry?.p) && entry.t >= cutoff)
      .sort(([, left], [, right]) => right.t - left.t);

    const retained: Array<[string, HotEntry]> = [];
    let totalChars = 0;
    for (const item of entries) {
      if (retained.length >= MAX_ENTRIES) break;
      const size = item[0].length + item[1].p.length;
      if (totalChars + size > MAX_TOTAL_CHARS) continue;
      retained.push(item);
      totalChars += size;
    }

    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(retained)));
  } catch {
    // Quota/security failures only disable the hot layer. IndexedDB remains the
    // durable encrypted cache and normal decryption remains available.
  }
}

export function readHotPlaintext(
  messageId: string | undefined,
  ciphertextBody: string,
): string | null {
  if (!ciphertextBody) return null;
  const key = hotKey(messageId, ciphertextBody);
  const now = Date.now();
  const inMemory = memory.get(key);
  if (inMemory) {
    if (now - inMemory.t <= TTL_MS) return inMemory.p;
    memory.delete(key);
  }

  const entry = readStore()[key];
  if (!entry?.p || now - entry.t > TTL_MS) return null;
  memory.set(key, entry);
  return entry.p;
}

export function writeHotPlaintext(
  messageId: string | undefined,
  ciphertextBody: string,
  plaintext: string,
): void {
  if (!ciphertextBody || !plaintext) return;
  const key = hotKey(messageId, ciphertextBody);
  const entry = { p: plaintext, t: Date.now() };
  memory.set(key, entry);

  // Keep very large payloads in RAM only to protect sessionStorage quota.
  if (plaintext.length > MAX_ENTRY_CHARS) return;
  const store = readStore();
  store[key] = entry;
  writeStore(store);
}

export function removeHotPlaintext(
  messageId: string | undefined,
  ciphertextBody: string,
): void {
  if (!ciphertextBody) return;
  const key = hotKey(messageId, ciphertextBody);
  memory.delete(key);
  const store = readStore();
  if (store[key]) {
    delete store[key];
    writeStore(store);
  }
}

export function clearHotPlaintextCache(): void {
  memory.clear();
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}
