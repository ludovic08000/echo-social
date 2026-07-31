import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';

// Scan executable TypeScript only; generated Supabase declarations are not runtime calls.
const read = (path: string) => readFileSync(path, 'utf8');
const generatedSupabaseTypes = normalize(join('src', 'integrations', 'supabase', 'types.ts'));

function readRuntimeSources(root: string): string {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name !== '__tests__')
    .map((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return readRuntimeSources(path);
      if (normalize(path) === generatedSupabaseTypes) return '';
      return ['.ts', '.tsx'].includes(extname(entry.name)) ? read(path) : '';
    })
    .join(String.fromCharCode(10));
}

describe('Aegis UI and final schema compatibility', () => {
  it('uses only RPC names supported by the final Aegis runtime contract', () => {
    const runtime = readRuntimeSources('src');
    expect(runtime).toContain('get_device_copies_for_messages');
    expect(runtime).not.toContain("'aegis_sync_device'");
    expect(runtime).not.toContain("'aegis_ack_device_messages'");
    expect(runtime).not.toContain("'get_device_copy_for_message'");
    expect(runtime).not.toContain("'send_message_with_device_copies'");
    expect(runtime).not.toContain("'insert_message_with_device_copies'");
    expect(runtime).not.toContain("'call_signal'");
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
