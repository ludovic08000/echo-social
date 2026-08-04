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
  it('uses only RPC names supported by the durable Aegis runtime contract', () => {
    const runtime = readRuntimeSources('src');
    expect(runtime).toContain("'aegis_send_message'");
    expect(runtime).toContain("'aegis_sync_device'");
    expect(runtime).toContain("'aegis_ack_device_messages'");
    expect(runtime).not.toContain("'get_device_copy_for_message'");
    expect(runtime).not.toContain("'send_message_with_device_copies'");
    expect(runtime).not.toContain("'insert_message_with_device_copies'");
    expect(runtime).not.toContain("'call_signal'");
  });

  it('pulls pending capsules through the authenticated durable inbox RPC', () => {
    const source = read('src/lib/messaging/aegisDeviceInbox.ts');
    expect(source).toContain("callAegisServer<AegisInboxRow[]>(");
    expect(source).toContain("'aegis_sync_device'");
    expect(source).toContain("table: 'messages'");
    expect(source).not.toContain(".from('messages')");
    expect(source).not.toContain(".from('message_device_copies')");
    expect(source).not.toContain("supabase.rpc('get_device_copies_for_messages'");
    expect(source).not.toContain(".from('aegis_device_inbox')");
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

  it('isolates inbox synchronization by authenticated user and device', () => {
    const source = read('src/lib/messaging/aegisDeviceInbox.ts');
    expect(source).toContain('const syncInflight = new Map<string, Promise<AegisInboxRow[]>>();');
    expect(source).toContain('const syncKey = `${userId}:${ready.deviceId}`;');
    expect(source).toContain("throw new Error('AEGIS_DEVICE_USER_MISMATCH')");
    expect(source).not.toContain('let syncInflight: Promise<AegisInboxRow[]> | null = null;');
  });

  it('hardens durable sync around the authenticated routable device and bounded input', () => {
    const migration = read('supabase/migrations/20260804154000_aegis_durable_database.sql');
    expect(migration).toContain('public.get_sesame_device_list(v_uid)');
    expect(migration).toContain('device.device_id = v_device_id');
    expect(migration).toContain('device.is_routable = true');
    expect(migration).toContain('least(greatest(coalesce(p_limit, 100), 1), 250)');
    expect(migration).toContain('inbox.recipient_user_id = v_uid');
    expect(migration).toContain('inbox.recipient_device_id = v_device_id');
    expect(migration).toContain('for update of inbox skip locked');
    expect(migration).toContain(
      'grant execute on function public.aegis_sync_device(text, integer)',
    );
  });
});
