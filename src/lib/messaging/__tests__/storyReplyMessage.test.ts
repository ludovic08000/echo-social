import { describe, expect, it } from 'vitest';
import { buildStoryReplyMessage } from '@/lib/messaging/storyReplyMessage';

describe('buildStoryReplyMessage', () => {
  it('keeps the reply in the encrypted body without creating an unkeyed media attachment', () => {
    const payload = buildStoryReplyMessage('  Salut !  ');

    expect(payload).toEqual({ body: '↩️ Réponse à votre story : Salut !' });
    expect(payload).not.toHaveProperty('imageUrl');
  });
});
