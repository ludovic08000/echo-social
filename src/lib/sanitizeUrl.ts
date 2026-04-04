/**
 * Sanitize URLs to prevent javascript: XSS attacks
 * Only allows http:, https:, mailto:, tel: protocols
 */
const SAFE_PROTOCOLS = ['https:', 'http:', 'mailto:', 'tel:'];

export function sanitizeUrl(url: string | null | undefined): string {
  if (!url) return '#';
  const trimmed = url.trim();
  if (!trimmed) return '#';

  try {
    // Handle protocol-relative URLs
    const testUrl = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
    const parsed = new URL(testUrl);
    if (SAFE_PROTOCOLS.includes(parsed.protocol)) {
      return trimmed;
    }
    return '#';
  } catch {
    // Relative URLs are safe (no protocol)
    if (/^[a-zA-Z0-9/]/.test(trimmed) && !trimmed.includes(':')) {
      return trimmed;
    }
    return '#';
  }
}

/**
 * Escape HTML special characters to prevent XSS in template literals
 */
export function escapeHtml(str: string | null | undefined): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
