/**
 * Encoded document attachment message body:
 *   📎 doc:<name>|<mime>|<sizeBytes>MKEY:<keyB64>
 * The encrypted blob URL is carried in messages.image_url (existing column).
 */
export function buildDocumentBody(name: string, mime: string, size: number, keyB64: string): string {
  const safeName = name.replace(/\|/g, '_').slice(0, 200);
  const safeMime = (mime || 'application/octet-stream').replace(/\|/g, '_');
  return `📎 doc:${safeName}|${safeMime}|${size}MKEY:${keyB64}`;
}

export interface ParsedDocument {
  name: string;
  mime: string;
  size: number;
  keyB64: string;
}

export function parseDocumentBody(body: string): ParsedDocument | null {
  const m = body.match(/^📎\s*doc:(.+?)\|([^|]+)\|(\d+)MKEY:([A-Za-z0-9+/=_-]+)$/);
  if (!m) return null;
  return { name: m[1], mime: m[2], size: parseInt(m[3], 10), keyB64: m[4] };
}

export function isDocumentMime(mime: string): boolean {
  return /pdf|msword|officedocument|excel|spreadsheet|presentation|zip|x-zip|text\//.test(mime);
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} o`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} Ko`;
  return `${(b / 1024 / 1024).toFixed(1)} Mo`;
}
