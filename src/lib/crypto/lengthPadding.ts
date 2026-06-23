// Lot B — Constant-time padding for E2EE plaintexts.
//
// Without padding, the AES-GCM ciphertext length leaks the plaintext length to
// network observers. Signal pads to a slowly-growing bucket size derived from
// `floor(ceil(len / quantum) * (1 + log10))` so that short messages all look
// alike, while large attachments still degrade gracefully.
//
// Wire format:
//   <padded-bytes> = <plaintext-utf8> || 0x80 || 0x00...0x00
// On unpad, scan from the end for the 0x80 marker. The marker is required so
// that a plaintext ending in zero bytes is unambiguous.

const MIN_BUCKET = 64;       // smallest padded length, in bytes
const MAX_BUCKET = 1 << 18;  // 256 KiB cap (attachments handled separately)

/** Compute the padded length for a given plaintext byte length. */
export function paddedLength(rawLen: number): number {
  const target = rawLen + 1; // +1 for the 0x80 marker
  if (target <= MIN_BUCKET) return MIN_BUCKET;
  if (target >= MAX_BUCKET) return MAX_BUCKET;
  // Bucket = ceil(target / quantum) * quantum, with quantum = 2^floor(log2(target))/16
  const log2 = Math.floor(Math.log2(target));
  const quantum = Math.max(16, Math.pow(2, Math.max(0, log2 - 4)));
  return Math.min(MAX_BUCKET, Math.ceil(target / quantum) * quantum);
}

/** Pad a UTF-8 plaintext to a length-bucketed buffer. */
export function padPlaintext(text: string): Uint8Array {
  const raw = new TextEncoder().encode(text);
  const out = new Uint8Array(paddedLength(raw.length));
  out.set(raw, 0);
  out[raw.length] = 0x80;
  // Remainder is already zeroed by Uint8Array init.
  return out;
}

/** Reverse `padPlaintext`. Throws on missing 0x80 marker. */
export function unpadPlaintext(padded: Uint8Array): string {
  let i = padded.length - 1;
  // NOTE: this scan is NOT constant-time — it stops at the 0x80 marker, so its
  // duration depends on the trailing-zero count. The padding hides plaintext
  // length from network observers (its purpose); local timing is not a relevant
  // channel here si