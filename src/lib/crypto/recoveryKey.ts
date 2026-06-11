/**
 * Recovery Key generation & formatting
 * 
 * Generates a cryptographically random 32-byte key, displayed as
 * a human-readable base32-like string grouped in blocks of 4.
 * This key is used as the "password" for PBKDF2 key derivation
 * when encrypting the backup bundle.
 * 
 * The recovery key NEVER leaves the client in plaintext.
 * 
 * SECURITY: Uses hardened crypto references to prevent XSS interception.
 */

import { hardCrypto } from './cryptoIntegrity';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous chars (0/O, 1/I/L)

/**
 * Generate a random 32-byte recovery key formatted as readable groups.
 * Output example: "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6789"
 */
export function generateRecoveryKey(): string {
  // SECURITY: Use hardened getRandomValues to prevent XSS interception
  const bytes = hardCrypto.getRandomValues(new Uint8Array(32));
  let encoded = '';
  for (let i = 0; i < bytes.length; i++) {
    encoded += ALPHABET[bytes[i] % ALPHABET.length];
  }
  // Group in blocks of 4 separated by dashes
  const groups: string[] = [];
  for (let i = 0; i < encoded.length; i += 4) {
    groups.push(encoded.slice(i, i + 4));
  }
  return groups.join('-');
}

/**
 * Normalize a recovery key input (strip spaces, dashes, lowercase → uppercase).
 */
export function normalizeRecoveryKey(input: string): string {
  return input
    .replace(/[\s\-_.]/g, '')
    .toUpperCase()
    .trim();
}

/**
 * Validate recovery key format: must be 32 characters from the alphabet after normalization.
 */
export function isValidRecoveryKey(input: string): boolean {
  const normalized = normalizeRecoveryKey(input);
  if (normalized.length !== 32) return false;
  return [...normalized].every(c => ALPHABET.includes(c));
}

/**
 * Format a normalized recovery key back into readable groups.
 */
export function formatRecoveryKey(normalized: string): string {
  const groups: string[] = [];
  for (let i = 0; i < normalized.length; i += 4) {
    groups.push(normalized.slice(i, i + 4));
  }
  return groups.join('-');
}
