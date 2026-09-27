const CALL_KEY_BYTES = 32;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/;

export class InvalidCallKeyError extends Error {
  readonly code = 'CALL_KEY_INVALID';

  constructor() {
    super('CALL_KEY_INVALID');
    this.name = 'InvalidCallKeyError';
  }
}

/** Generate the 256-bit media key consumed by LiveKit frame encryption. */
export function generateCallE2EEKey(): string {
  const key = crypto.getRandomValues(new Uint8Array(CALL_KEY_BYTES));
  return btoa(String.fromCharCode(...key));
}

/**
 * Decode a canonical 256-bit call key.
 *
 * Rejecting alternate/malformed encodings before they reach LiveKit avoids
 * accidental key truncation and keeps the invitation envelope contract exact.
 */
export function decodeCallE2EEKey(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !CANONICAL_BASE64.test(value)) {
    throw new InvalidCallKeyError();
  }

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new InvalidCallKeyError();
  }
  if (binary.length !== CALL_KEY_BYTES || btoa(binary) !== value) {
    throw new InvalidCallKeyError();
  }

  const decoded = new Uint8Array(CALL_KEY_BYTES);
  for (let index = 0; index < binary.length; index += 1) {
    decoded[index] = binary.charCodeAt(index);
  }
  return decoded as Uint8Array<ArrayBuffer>;
}

export function isValidCallE2EEKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    decodeCallE2EEKey(value);
    return true;
  } catch {
    return false;
  }
}
