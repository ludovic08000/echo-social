/**
 * Signal "Sender Keys" — group encryption foundation.
 *
 * Why: with N pairwise device ratchets, sending a group message of size M
 * costs N*M bytes uploaded and N AES-GCM operations per send. Sender Keys
 * pivot to ONE symmetric chain per (group, sender-device): the message is
 * encrypted ONCE; only the SKDM (Sender Key Distribution Message — 32-byte
 * chain key + signing pub) is fanned out pairwise via the existing device
 * ratchet, and only when a member joins, leaves, or rotates.
 *
 * Spec reference: https://signal.org/docs/specifications/sender-key/
 *
 * STATUS: foundation only. Wired to the DB tables `sender_key_state` and
 * `sender_key_distribution`. Encryption / decryption helpers are exported
 * but NOT yet plugged into the message send path — that switch happens
 * once `enable_sender_keys` is set on a conversation and all member
 * devices have a corresponding SKDM delivered.
 */
import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { base64ToBuffer, bufferToBase64, randomBytes, constantTimeEqual } from './utils';

const CHAIN_INFO_KDF = 'ForSure/SenderKey/v1/chain';
const MSG_INFO_KDF = 'ForSure/SenderKey/v1/msg';

/**
 * Generate a brand-new sender key (called when a sender first sends to a
 * group, or when membership changes and the chain must rotate).
 */
export async function generateSenderKey(): Promise<{
  chainKeyB64: string;
  signingPubB64: string;
  signingPrivJwk: JsonWebKey;
}> {
  const chain = randomBytes(32);
  // Use ECDSA P-256 — broadly supported in Web Crypto for sign/verify of
  // the per-message header (we don't ship Ed25519 in browsers without an
  // extra dep). The header signature defends against a compromised group
  // member injecting forged messages under another member's chain.
  const kp = await hardCrypto.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  const pub = await hardCrypto.exportKey('raw', kp.publicKey);
  const priv = await hardCrypto.exportKey('jwk', kp.privateKey);
  return {
    chainKeyB64: bufferToBase64(chain.buffer as ArrayBuffer),
    signingPubB64: bufferToBase64(pub as ArrayBuffer),
    signingPrivJwk: priv,
  };
}

/**
 * Advance the chain key one step and derive the message key for the
 * current iteration. Pure function — caller must persist the new chain.
 *
 *   nextChain = HKDF(chain, info=chain)
 *   msgKey    = HKDF(chain, info=msg)
 */
export async function deriveStep(chainKeyB64: string): Promise<{
  nextChainB64: string;
  msgKeyB64: string;
}> {
  const ck = base64ToBuffer(chainKeyB64);
  const baseKey = await hardCrypto.importKey('raw', ck, { name: 'HKDF' }, false, ['deriveBits']);
  const next = await hardCrypto.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new hardGlobals.TextEncoder().encode(CHAIN_INFO_KDF),
    },
    baseKey,
    256,
  );
  const mk = await hardCrypto.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new hardGlobals.TextEncoder().encode(MSG_INFO_KDF),
    },
    baseKey,
    256,
  );
  return {
    nextChainB64: bufferToBase64(next as ArrayBuffer),
    msgKeyB64: bufferToBase64(mk as ArrayBuffer),
  };
}

export const SENDER_KEY_PREFIX = 'sk1.';

/**
 * Encrypt a plaintext under the message key derived from the current chain
 * iteration. Returns the wire string `sk1.<conv>.<senderDev>.<iter>.<sigPub>.<iv>.<ct>.<sig>`.
 *
 * The signature covers the full ciphertext + AAD `(conv|sender|iter)` so
 * receivers can verify provenance even if a malicious member learns the
 * chain key (defense in depth — symmetric chain by itself has no auth).
 */
export async function senderKeyEncrypt(args: {
  conversationId: string;
  senderDeviceId: string;
  iteration: number;
  msgKeyB64: string;
  signingPrivJwk: JsonWebKey;
  signingPubB64: string;
  plaintext: string;
}): Promise<string> {
  const { iteration, msgKeyB64, plaintext } = args;
  const aes = await hardCrypto.importKey(
    'raw',
    base64ToBuffer(msgKeyB64),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = randomBytes(12);
  const aad = new hardGlobals.TextEncoder().encode(
    `${args.conversationId}|${args.senderDeviceId}|${iteration}`,
  );
  const ct = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, additionalData: aad, tagLength: 128 },
    aes,
    new hardGlobals.TextEncoder().encode(plaintext),
  );
  const ctB64 = bufferToBase64(ct as ArrayBuffer);
  const ivB64 = bufferToBase64(iv.buffer as ArrayBuffer);

  const signKey = await hardCrypto.importKey(
    'jwk',
    args.signingPrivJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const toSign = new hardGlobals.TextEncoder().encode(
    `${args.conversationId}|${args.senderDeviceId}|${iteration}|${ivB64}|${ctB64}`,
  );
  const sig = await hardCrypto.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, toSign);
  const sigB64 = bufferToBase64(sig as ArrayBuffer);

  return [
    SENDER_KEY_PREFIX + args.conversationId,
    args.senderDeviceId,
    String(iteration),
    args.signingPubB64,
    ivB64,
    ctB64,
    sigB64,
  ].join('.');
}

/**
 * Decrypt a `sk1.` wire string given the chain key for the matching
 * iteration. Caller is responsible for fast-forwarding the chain to
 * `iteration` (use `deriveStep` repeatedly).
 *
 * H1 (audit) — provenance binding: `expectedSigningPubB64` is the signing
 * public key pinned in the trusted recipient state (from the SKDM). The
 * signature in the wire is verified against THIS pinned key, not the key the
 * wire carries. We also reject any wire whose embedded signing key differs
 * from the pinned one. Without this, the per-message signature is
 * self-referential and anyone who learns the chain key can forge messages
 * with their own signing keypair. The parameter is optional only for
 * backward-compat with callers that have not yet pinned a key; callers in the
 * group path MUST pass it.
 */
export async function senderKeyDecrypt(
  wire: string,
  chainKeyB64ForIter: string,
  expectedSigningPubB64?: string,
): Promise<string | null> {
  if (!wire.startsWith(SENDER_KEY_PREFIX)) return null;
  const parts = wire.slice(SENDER_KEY_PREFIX.length).split('.');
  if (parts.length !== 7) return null;
  const [convId, senderDev, iterStr, sigPubB64, ivB64, ctB64, sigB64] = parts;
  const iter = parseInt(iterStr, 10);
  if (Number.isNaN(iter)) return null;

  // H1: the wire's signing key MUST match the trusted (pinned) one.
  if (expectedSigningPubB64 !== undefined) {
    try {
      const a = new Uint8Array(base64ToBuffer(sigPubB64));
      const b = new Uint8Array(base64ToBuffer(expectedSigningPubB64));
      if (!constantTimeEqual(a, b)) return null;
    } catch {
      return null;
    }
  }

  // Verify the signature against the PINNED key (falls back to the wire key
  // only when no pinned key was supplied — legacy callers).
  const verifyPubB64 = expectedSigningPubB64 ?? sigPubB64;

  // Verify signature first — fail fast on forged ciphertexts.
  try {
    const verifyKey = await hardCrypto.importKey(
      'raw',
      base64ToBuffer(verifyPubB64),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await hardCrypto.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      base64ToBuffer(sigB64),
      new hardGlobals.TextEncoder().encode(
        `${convId}|${senderDev}|${iter}|${ivB64}|${ctB64}`,
      ),
    );
    if (!ok) return null;
  } catch {
    return null;
  }

  const { msgKeyB64 } = await deriveStep(chainKeyB64ForIter);
  const aes = await hardCrypto.importKey(
    'raw',
    base64ToBuffer(msgKeyB64),
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const aad = new hardGlobals.TextEncoder().encode(
    `${convId}|${senderDev}|${iter}`,
  );
  try {
    const pt = await hardCrypto.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(base64ToBuffer(ivB64)) as Uint8Array<ArrayBuffer>,
        additionalData: aad,
        tagLength: 128,
      },
      aes,
      base64ToBuffer(ctB64),
    );
    return new hardGlobals.TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/**
 * Build an SKDM (Sender Key Distribution Message). Sent ONCE per recipient
 * device via the existing pairwise device ratchet — `body` is what we
 * hand to `ratchetEncrypt`.
 */
export function buildSKDM(args: {
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  iteration: num