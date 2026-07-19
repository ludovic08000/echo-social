export const KIBIBYTE = 1024;
export const MEBIBYTE = 1024 * 1024;

/**
 * Signal Desktop reads these values from remote configuration. Its fallback is
 * 100 MiB for outgoing attachments, 125 MiB for incoming attachments and
 * 200 MiB for automatic downloads. Aegis keeps the same deterministic
 * fallback until it has an equivalent signed remote-config channel.
 */
export const MAX_OUTGOING_ATTACHMENT_CIPHERTEXT_BYTES = 100 * MEBIBYTE;
export const MAX_INCOMING_ATTACHMENT_CIPHERTEXT_BYTES = 125 * MEBIBYTE;
export const MAX_AUTO_DOWNLOAD_ATTACHMENT_BYTES = 200 * MEBIBYTE;

export const MEDIA_AES_GCM_IV_BYTES = 12;
export const MEDIA_AES_GCM_TAG_BYTES = 16;
export const MEDIA_AES_GCM_OVERHEAD_BYTES = MEDIA_AES_GCM_IV_BYTES + MEDIA_AES_GCM_TAG_BYTES;

/** Maximum clear file size that still produces a ciphertext at or below 100 MiB. */
export const MAX_OUTGOING_ATTACHMENT_PLAINTEXT_BYTES =
  MAX_OUTGOING_ATTACHMENT_CIPHERTEXT_BYTES - MEDIA_AES_GCM_OVERHEAD_BYTES;

export function getEncryptedMediaSize(plaintextBytes: number): number {
  return plaintextBytes + MEDIA_AES_GCM_OVERHEAD_BYTES;
}

export function isOutgoingAttachmentTooLarge(plaintextBytes: number): boolean {
  return getEncryptedMediaSize(plaintextBytes) > MAX_OUTGOING_ATTACHMENT_CIPHERTEXT_BYTES;
}

export function isIncomingAttachmentTooLarge(ciphertextBytes: number): boolean {
  return ciphertextBytes > MAX_INCOMING_ATTACHMENT_CIPHERTEXT_BYTES;
}

export function formatAttachmentLimit(bytes: number): string {
  const mib = bytes / MEBIBYTE;
  return Number.isInteger(mib) ? `${mib} Mio` : `${mib.toFixed(1)} Mio`;
}
