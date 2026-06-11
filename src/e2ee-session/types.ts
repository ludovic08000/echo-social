/**
 * Centralized E2EE session types — Sesame-inspired multi-device routing.
 *
 * IMPORTANT: these types describe the *façade* exposed to messaging code.
 * The actual cryptographic primitives live in `src/lib/crypto/*` and remain
 * the source of truth. This module never re-implements crypto.
 */

export type DeviceId = string;
export type UserId = string;
/** `${userA}::${devA}::${userB}::${devB}` — sorted-pair stable key. */
export type SessionId = string;

export type SessionStatus = 'active' | 'inactive' | 'archived';

export interface DeviceDescriptor {
  userId: UserId;
  deviceId: DeviceId;
  /** Published per-device public key (X25519 raw, base64). */
  devicePublicKey: string;
  /** Last time we successfully exchanged with this device, ms epoch. */
  lastSeen?: number;
}

export interface SessionDescriptor {
  sessionId: SessionId;
  selfUserId: UserId;
  selfDeviceId: DeviceId;
  peerUserId: UserId;
  peerDeviceId: DeviceId;
  status: SessionStatus;
  /** Crypto layer that owns this session (informational). */
  layer: 'ratchet-v5' | 'ratchet-v4' | 'ratchet-v3-legacy' | 'x3dh-bootstrap' | 'device-wrap-legacy';
  createdAt: number;
  lastUsedAt: number;
}

/**
 * Canonical envelope shape for *new* messages (v4/v5 ratchet wire format).
 * Old wire formats are still understood by `legacyDecryptRouter` — we never
 * change the shape of historical envelopes already on the server.
 */
export interface EncryptedMessageEnvelope {
  version: 4 | 5;
  type: 'initial' | 'ratchet' | 'legacy';
  fromUserId: UserId;
  toUserId: UserId;
  fromDeviceId: DeviceId;
  toDeviceId: DeviceId;
  sessionId: SessionId;
  /** Sender chain message number (mirrors Double Ratchet `Ns`). */
  seq: number;
  ciphertext: string;
  /** Base64 IV / nonce. */
  nonce: string;
  /** Base64 Ed25519 signature (or empty when underlying layer signs internally). */
  signature: string;
  createdAt: string;
}

export interface DecryptResult {
  ok: boolean;
  plaintext: string | null;
  /** Which path actually decrypted (for diagnostics, never shown to user). */
  via?:
    | 'ratchet-v5'
    | 'ratchet-v4'
    | 'ratchet-v3'
    | 'x3dh-bootstrap'
    | 'device-wrap'
    | 'fallback-session'
    | 'fallback-session-probe'
    | 'fallback-device-copy'
    | 'legacy-router'
    | 'plaintext-cache';
  /** Internal error code — never surfaced to UI. */
  errorCode?: string;
}

export interface PendingEnvelope {
  /** Server message id (or device-copy id) used to dedupe. */
  envelopeId: string;
  envelope: unknown;
  enqueuedAt: number;
  attempts: number;
}
