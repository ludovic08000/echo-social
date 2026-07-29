import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('server privacy boundary', () => {
  it('never sends an Aegis private message to server AI moderation', () => {
    const moderation = source('../../../../supabase/functions/message-moderation/index.ts');
    expect(moderation).toContain('e2ee_client_private');
    expect(moderation).toContain('authoritativeMessage.sender_id !== user.id');
    expect(moderation).toContain('bodyKind !== "system" || storedBody !== messageBody');
  });

  it('uses generic notification text for private messages', () => {
    const push = source('../../../../supabase/functions/push-notify/index.ts');
    expect(push).toContain('isPrivateMessagePush');
    expect(push).toContain('Ouvre ForSure pour le déchiffrer.');
    expect(push).not.toContain('title, body: msgBody || ""');
  });
});
