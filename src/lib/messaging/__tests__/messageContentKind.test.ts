import { describe, expect, it } from 'vitest';
import { classifyAegisContentKind } from '@/lib/messaging/messageContentKind';

describe('Aegis public content-kind routing metadata', () => {
  it('keeps ordinary text eligible for a first message request', () => {
    expect(classifyAegisContentKind({ plaintext: 'Salut, ça va ?' })).toBe('text');
  });

  it.each([
    [{ plaintext: 'GIF:https://cdn.example/cat.gif' }, 'gif'],
    [{ plaintext: '🎙️ voice:https://cdn.example/voice.enc|dur:4' }, 'voice'],
    [{ plaintext: '📎 doc:facture.pdf|application/pdf|10MKEY:key', extra: { document_url: 'cipher.pdf' } }, 'document'],
    [{ plaintext: '📷 Photo\x00MKEY:key', imageUrl: 'cipher.bin' }, 'image'],
    [{ plaintext: '🎬 Vidéo\x00MKEY:key', imageUrl: 'cipher.bin' }, 'video'],
    [{ plaintext: '📝 Publication partagée : exemple' }, 'shared_content'],
    [{ plaintext: '💰 OFFRE: 10 €' }, 'commerce'],
    [{ plaintext: '📞 CALL:missed|audio' }, 'call_event'],
  ] as const)('classifies non-text payload %o as %s', (input, expected) => {
    expect(classifyAegisContentKind(input)).toBe(expected);
  });
});
