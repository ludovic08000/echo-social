/**
 * Signup data integrity: HMAC-SHA256 signing to prevent sessionStorage tampering.
 * The key is derived from the password (which the user knows) + a random nonce.
 * An attacker modifying sessionStorage cannot re-sign without the original password.
 * 
 * SECURITY: Password is NEVER stored in sessionStorage — only a derived hash.
 */

const STORAGE_KEY = 'forsure_signup_pending';
const NONCE_KEY = 'forsure_signup_nonce';

async function deriveKey(password: string, nonce: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password + nonce), 'HMAC', false, ['sign', 'verify']
  ).catch(() =>
    crypto.subtle.importKey('raw', enc.encode(password + nonce), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  );
  return keyMaterial;
}

async function hmacSign(key: CryptoKey, data: string): Promise<string> {
  const enc = new TextEncoder();
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Hash the password so we never store it in plaintext */
async function hashPassword(password: string, nonce: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(password + ':' + nonce + ':forsure-signup-guard');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Data stored in sessionStorage — password is EXCLUDED */
export interface StoredSignupData {
  email: string;
  name: string;
  dateOfBirth: string;
  phoneNumber: string;
  parentalPin: string | null;
}

/** Full signup payload including password (only in memory) */
export interface SignupPayload extends StoredSignupData {
  password: string;
}

/** Compute age from DOB string (YYYY-MM-DD) */
export function computeAgeFromDOB(dob: string): number {
  const birth = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

/** Store signup data with HMAC integrity signature. Password is NOT stored. */
export async function storeSignupData(data: SignupPayload): Promise<void> {
  const nonce = crypto.randomUUID();

  // Store everything EXCEPT password
  const storedData: StoredSignupData = {
    email: data.email,
    name: data.name,
    dateOfBirth: data.dateOfBirth,
    phoneNumber: data.phoneNumber,
    parentalPin: data.parentalPin,
  };

  const payload = JSON.stringify(storedData);

  // Derive HMAC key from password + nonce
  const key = await deriveKey(data.password, nonce);
  const signature = await hmacSign(key, payload);

  // Store a hash of the password for verification (NOT the password itself)
  const passwordHash = await hashPassword(data.password, nonce);

  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ payload, signature, passwordHash }));
  sessionStorage.setItem(NONCE_KEY, nonce);
}

/** Load and verify signup data integrity. Returns null if tampered. Password must be re-provided. */
export async function loadSignupData(password: string): Promise<SignupPayload | null> {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  const nonce = sessionStorage.getItem(NONCE_KEY);
  if (!raw || !nonce) return null;

  try {
    const { payload, signature, passwordHash } = JSON.parse(raw);

    // Verify the password hash matches
    const expectedHash = await hashPassword(password, nonce);
    if (expectedHash !== passwordHash) {
      console.error('[SIGNUP_INTEGRITY] Invalid password for stored data');
      return null;
    }

    // Verify HMAC signature
    const key = await deriveKey(password, nonce);
    const expected = await hmacSign(key, payload);

    if (expected !== signature) {
      console.error('[SIGNUP_INTEGRITY] Tampered data detected — clearing');
      clearSignupData();
      return null;
    }

    const storedData = JSON.parse(payload) as StoredSignupData;
    return { ...storedData, password };
  } catch {
    clearSignupData();
    return null;
  }
}

/** Quick check: is there pending signup data (without verification) */
export function hasSignupData(): boolean {
  return sessionStorage.getItem(STORAGE_KEY) !== null;
}

/** Load raw signup data (for display only — NO password included) */
export function loadSignupDataRaw(): StoredSignupData | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const { payload } = JSON.parse(raw);
    return JSON.parse(payload) as StoredSignupData;
  } catch {
    return null;
  }
}

export function clearSignupData(): void {
  sessionStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(NONCE_KEY);
}
