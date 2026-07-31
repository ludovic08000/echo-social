import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('Aegis UI and final schema compatibility', () => {
  it('uses only the final device-copy RPC path', () => {
    const source = read('src/lib/messaging/aegisDeviceInbox.ts');
    expect(source).toContain(".from('message_device_copies')");
    expect(source).toContain('get_device_copies_for_messages');
    expect(source).not.toContain("'aegis_sync_device'");
    expect(source).not.toContain("'aegis_ack_device_messages'");
  });

  it('renders a pending bubble before the first server message exists', () => {
    const source = read('src/components/ChatWidget.tsx');
    expect(source).toContain(
      '(messages?.length ?? 0) === 0 && queue.pendingMessages.length === 0',
    );
    expect(source).toContain(
      'key={pm.localId} className="flex justify-end mt-1 px-2"',
    );
  });

  it('does not bind mark-read to an unstable mutation result object', () => {
    const source = read('src/components/ChatWidget.tsx');
    expect(source).toContain(
      'const { mutate: markConversationRead } = useMarkConversationRead();',
    );
    expect(source).toContain('[conversationId, markConversationRead]');
    expect(source).not.toContain('[conversationId, markRead]');
  });

  it('does not force the conversations query to refetch on every widget mount', () => {
    const source = read('src/hooks/useMessages.ts');
    const start = source.indexOf('export function useConversations()');
    const end = source.indexOf('export function useMessages(');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const conversationSource = source.slice(start, end);
    expect(conversationSource).toContain("queryKey: ['conversations', user?.id ?? 'anon']");
    expect(source).toContain("queryKey: ['conversations', userId]");
    expect(conversationSource).toContain('refetchOnMount: false');
    expect(conversationSource).not.toContain("refetchOnMount: 'always'");
  });
});
