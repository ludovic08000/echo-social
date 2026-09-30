import type { OutboxExtra } from '@/lib/messaging/outboxVault';
import type { AegisContentKind } from '@/lib/messaging/aegisEnvelope';

export interface AegisContentClassificationInput {
  plaintext: string;
  imageUrl?: string | null;
  extra?: OutboxExtra;
}

function looksLikeVideo(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes('🎬') ||
    normalized.includes('vidéo') ||
    normalized.includes('video') ||
    /\.(mp4|mov|webm|avi|mkv)(?:$|[?#])/i.test(normalized);
}

function looksLikeGif(value: string): boolean {
  return value.startsWith('GIF:') ||
    value.includes('🎞️ GIF') ||
    /\.gif(?:$|[?#])/i.test(value);
}

/**
 * Public routing metadata only. The plaintext remains encrypted; this narrow
 * label lets the server enforce that a first non-contact request is text-only.
 */
export function classifyAegisContentKind({
  plaintext,
  imageUrl,
  extra,
}: AegisContentClassificationInput): AegisContentKind {
  const body = plaintext.trim();

  if (extra?.document_url || body.startsWith('📎 doc:')) return 'document';
  if (body.startsWith('🎙️ ') && /(?:voice|vocal):/i.test(body)) return 'voice';
  if (body.startsWith('📞 CALL:')) return 'call_event';
  if (looksLikeGif(body) || (imageUrl ? looksLikeGif(imageUrl) : false)) return 'gif';

  if (imageUrl || body.includes('\x00MKEY:')) {
    return looksLikeVideo(body) || (imageUrl ? looksLikeVideo(imageUrl) : false)
      ? 'video'
      : 'image';
  }

  if (
    body.startsWith('📝 Publication partagée') ||
    body.startsWith('🛍️ ') ||
    body.startsWith('🔴 Live en cours') ||
    body.startsWith('↪️ Message transféré:')
  ) {
    return 'shared_content';
  }

  if (
    body.startsWith('💰 OFFRE:') ||
    body.startsWith('✅ OFFRE') ||
    body.startsWith('❌ OFFRE') ||
    body.startsWith('🔄 CONTRE') ||
    body.startsWith('✅ CONTRE')
  ) {
    return 'commerce';
  }

  return 'text';
}
