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

  it('discovers inbox candidates through RLS-visible messages only', () => {
    const source = read('src/lib/messaging/aegisDeviceInbox.ts');
    expect(source).toContain(".from('messages')");
    expect(source).toContain("table: 'messages'");
    expect(source).not.toContain(".from('message_device_copies')");
    expect(source).toContain("supabase.rpc('get_device_copies_for_messages'");
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
    expect(source).toContain(
      '[conversationId, latestIncomingMessageId, markConversationRead]',
    );
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

  it('scopes every conversation invalidation to the authenticated user', () => {
    const source = read('src/hooks/useMessages.ts');
    expect(source).toContain('invalidateUserConversations');
    expect(source).not.toContain("queryClient.invalidateQueries({ queryKey: ['conversations'] });");
  });

  it('marks an open conversation read again when a new incoming message arrives', () => {
    const source = read('src/components/ChatWidget.tsx');
    expect(source).toContain('const latestIncomingMessageId = messages?.reduce<string | undefined>');
    expect(source).toContain('[conversationId, latestIncomingMessageId, markConversationRead]');
  });

  it('hardens the device-copy RPC around membership, active device and bounded input', () => {
    const migration = read('supabase/migrations/20260801142000_harden_device_copy_lookup.sql');
    expect(migration).toContain('join public.conversation_participants participant');
    expect(migration).toContain("coalesce(cardinality(p_message_ids), 0) between 1 and 200");
    expect(migration).toContain("coalesce(device.approval_status, 'approved') = 'approved'");
    expect(migration).toContain('device.revoked_at is null');
    expect(migration).toContain("grant execute on function public.get_device_copies_for_messages(uuid[],text) to authenticated");
  });

});
