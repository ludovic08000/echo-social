import { useEffect, useMemo, useState } from 'react';
import { isStrictRatchetEnvelopeBody, isCryptoJsonBody } from '@/lib/messaging/messageCompatibility';
import { loadPlaintextForCiphertext } from '@/lib/crypto/plaintextStore';

interface ConversationPreviewTextProps {
  body?: string | null;
  emptyText?: string;
  maxLength?: number;
}

// Detect any encrypted-looking payload that should NEVER be shown raw to the user.
// Covers strict ratchet envelopes, legacy crypto JSON, and pipeline wrappers like
// {"fs_secure_pipeline":1,"body":"..."} or anything containing crypto markers.
function looksEncrypted(body: string): boolean {
  if (!body) return false;
  if (isStrictRatchetEnvelopeBody(body)) return true;
  if (isCryptoJsonBody(body)) return true;
  // Wrapped pipelines / unknown JSON envelopes that leak through
  if (body.startsWith('{') && /"(fs_secure_pipeline|kem|hdr|ct|encryptionMode|iv|sig|fp)"/.test(body)) {
    return true;
  }
  return false;
}

function formatPreview(body: string, maxLength: number) {
  if (body.startsWith('📞 CALL:missed|')) {
    return `📞 Appel ${body.includes('video') ? 'vidéo' : 'audio'} manqué`;
  }
  if (body.startsWith('📞 CALL:ended|')) {
    return `📞 Appel ${body.includes('video') ? 'vidéo' : 'audio'} terminé`;
  }
  if (/^🎙️\s*(?:vocal|voice):/.test(body)) return '🎙️ Message vocal';
  if (/^GIF:https?:\/\//i.test(body)) return '🖼️ GIF';
  if (/^📷\s*Photo(MKEY:|$)/i.test(body) || /PhotoMKEY:/i.test(body)) return '📷 Photo';
  if (/^🎬\s*(Video|Vidéo)(MKEY:|$)/i.test(body) || /VideoMKEY:/i.test(body)) return '🎬 Vidéo';
  if (/^📎\s*(File|Fichier)(MKEY:|$)/i.test(body) || /FileMKEY:/i.test(body)) return '📎 Fichier';
  // Final safety net: never leak raw JSON / ciphertext to the preview
  if (looksEncrypted(body)) return '🔒 Nouveau message';
  return body.length > maxLength ? `${body.substring(0, maxLength)}…` : body;
}

export function ConversationPreviewText({ body, emptyText = 'Démarrez la conversation…', maxLength = 80 }: ConversationPreviewTextProps) {
  const [resolvedPlaintext, setResolvedPlaintext] = useState<string | null>(null);
  const encrypted = !!body && looksEncrypted(body);

  useEffect(() => {
    if (!body || !encrypted) {
      setResolvedPlaintext(null);
      return;
    }

    let cancelled = false;
    loadPlaintextForCiphertext(body).then((plaintext) => {
      if (!cancelled) setResolvedPlaintext(plaintext);
    }).catch(() => {
      if (!cancelled) setResolvedPlaintext(null);
    });

    return () => {
      cancelled = true;
    };
  }, [body, encrypted]);

  const preview = useMemo(() => {
    if (!body) return emptyText;
    if (encrypted && resolvedPlaintext) return formatPreview(resolvedPlaintext, maxLength);
    if (encrypted) return '🔒 Nouveau message';
    return formatPreview(body, maxLength);
  }, [body, emptyText, encrypted, maxLength, resolvedPlaintext]);

  return <>{preview}</>;
}
