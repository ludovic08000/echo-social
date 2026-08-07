import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
    return /\.tsx?$/u.test(entry.name) ? [entryPath] : [];
  });
}

const initialMigration = readFileSync(
  'supabase/migrations/20260806232000_block_plaintext_zeus_messaging.sql',
  'utf8',
);
const durableMigration = readFileSync(
  'supabase/migrations/20260806233500_remove_zeus_plaintext_messenger.sql',
  'utf8',
);
const shellCleanupMigration = readFileSync(
  'supabase/migrations/20260806234000_close_zeus_messenger_shells.sql',
  'utf8',
);
const sqlSecurityTest = readFileSync(
  'supabase/tests/zeus_plaintext_messaging.sql',
  'utf8',
);
const messagesPublicApi = readFileSync('src/hooks/useMessages.ts', 'utf8');
const secureSendHook = readFileSync('src/hooks/useSendMessageSecure.ts', 'utf8');
const legacyMessagesHook = readFileSync('src/hooks/useMessages.legacy.ts', 'utf8');
const agentChat = readFileSync('supabase/functions/agent-chat/index.ts', 'utf8');

describe('Zeus plaintext boundary', () => {
  it('keeps future Zeus welcomes outside the regular messenger', () => {
    expect(durableMigration).toContain('create or replace function public.zeus_welcome_new_user()');
    expect(durableMigration).toContain('anonymous_wall_messages');

    const welcomeFunction = durableMigration.slice(
      durableMigration.indexOf('create or replace function public.zeus_welcome_new_user()'),
      durableMigration.indexOf('create or replace function public.reject_zeus_messenger_participant()'),
    );
    expect(welcomeFunction).not.toContain('insert into public.messages');
    expect(welcomeFunction).not.toContain('insert into public.conversations');
  });

  it('scrubs legacy plaintext and its archive copies without deleting message rows', () => {
    for (const migration of [initialMigration, durableMigration]) {
      expect(migration).toContain('update public.message_archives');
      expect(migration).toContain("archive_body = '[zeus_messenger_removed]'");
      expect(migration).toContain("body = '[zeus_messenger_removed]'");
      expect(migration).toContain('archive_body = null');
      expect(migration).toContain("status = 'blocked'");
      expect(migration).not.toContain('delete from public.messages');
    }
  });

  it('guards optional archive relations during full migration replay', () => {
    for (const migration of [initialMigration, durableMigration]) {
      expect(migration).toContain("to_regclass('public.message_archives') is not null");
      expect(migration).toContain("table_name = 'message_archives'");
      expect(migration).toContain("column_name = 'archive_body'");
      expect(migration).toContain('execute $sql$');
    }
  });

  it('persists the blocked conversation before suppressing Zeus', () => {
    expect(durableMigration).toContain('zeus_messenger_blocked_conversations');
    expect(durableMigration).toContain('enable row level security');
    expect(durableMigration).toContain('insert into public.zeus_messenger_blocked_conversations');
    expect(durableMigration).toContain('on conflict (conversation_id) do update');
    expect(durableMigration).toContain('blocked.conversation_id = new.conversation_id');
  });

  it('uses the canonical database guards asserted by pgTAP', () => {
    expect(durableMigration).toContain('create or replace function public.reject_plaintext_zeus_messenger()');
    expect(durableMigration).toContain('create trigger reject_plaintext_zeus_messenger');
    expect(durableMigration).toContain('create or replace function public.reject_zeus_messenger_participant()');
    expect(durableMigration).toContain('create trigger reject_zeus_messenger_participant');

    expect(sqlSecurityTest).toContain("to_regprocedure('public.reject_plaintext_zeus_messenger()')");
    expect(sqlSecurityTest).toContain("trigger.tgname = 'reject_plaintext_zeus_messenger'");
    expect(sqlSecurityTest).toContain("to_regprocedure('public.reject_zeus_messenger_participant()')");
    expect(sqlSecurityTest).toContain("trigger.tgname = 'reject_zeus_messenger_participant'");
  });

  it('routes the public messenger send hook through Aegis only', () => {
    expect(messagesPublicApi).toContain("export * from './useMessages.legacy'");
    expect(messagesPublicApi).toContain("export { useSendMessage } from './useSendMessageSecure'");
    expect(messagesPublicApi).not.toContain('sendToZeus');

    expect(secureSendHook).toContain('sendAegisOutboundMessage');
    expect(secureSendHook).toContain('useSendMessage');
    expect(secureSendHook).toContain('ZEUS_BOT_ID');
    expect(secureSendHook).not.toContain('sendToZeus');
    expect(secureSendHook).not.toContain("functions.invoke('agent-chat'");
    expect(secureSendHook).not.toContain("from('messages')\n        .insert");
    expect(secureSendHook).not.toContain("from './useMessages.legacy'");
  });

  it('rejects Zeus before encryption or optimistic messenger persistence', () => {
    expect(secureSendHook).toContain('assertRegularMessengerConversation');
    expect(secureSendHook).toContain("from('conversation_participants')");
    expect(secureSendHook).toContain(".eq('user_id', ZEUS_BOT_ID)");
    expect(secureSendHook).toContain('await assertRegularMessengerConversation(conversationId);');
    expect(secureSendHook.indexOf('await assertRegularMessengerConversation(conversationId);'))
      .toBeLessThan(secureSendHook.indexOf('sendAegisOutboundMessage'));
    expect(secureSendHook).not.toContain('onMutate:');
    expect(secureSendHook).not.toContain('optimistic-');
  });

  it('allows the legacy module only behind the controlled public facade', () => {
    const testPath = 'src/lib/messaging/__tests__/zeusPlaintextBoundary.test.ts';
    const normalizePath = (path: string) => relative('.', path).replace(/\\/gu, '/');
    const directReferences = collectTypeScriptFiles('src')
      .filter((path) => normalizePath(path) !== testPath)
      .filter((path) => readFileSync(path, 'utf8').includes('useMessages.legacy'))
      .map(normalizePath)
      .sort();

    expect(directReferences).toEqual(['src/hooks/useMessages.ts']);
    expect(legacyMessagesHook).toContain('sendToZeus');
    expect(legacyMessagesHook).toContain('export function useSendMessage()');
    expect(messagesPublicApi.indexOf("export { useSendMessage } from './useSendMessageSecure'"))
      .toBeGreaterThan(messagesPublicApi.indexOf("export * from './useMessages.legacy'"));
  });

  it('rejects legacy plaintext paths at the database boundary', () => {
    expect(durableMigration).toContain("new.sender_id = '00000000-0000-0000-0000-000000000001'::uuid");
    expect(durableMigration).toContain("message = 'zeus_messenger_e2ee_required'");
    expect(durableMigration).toContain('return null;');
  });

  it('detaches historical and newly attempted Zeus conversation shells', () => {
    expect(durableMigration).toContain('delete from public.conversation_participants');
    expect(durableMigration).toContain('from public.zeus_messenger_blocked_conversations blocked');
    expect(shellCleanupMigration).toContain('delete from public.conversation_participants participant');
    expect(shellCleanupMigration).toContain('participant.conversation_id = new.conversation_id');
    expect(sqlSecurityTest).toContain("'delete from public.conversation_participants'");
  });

  it('keeps the remaining server legacy push behind the database invariant', () => {
    expect(agentChat).toContain('pushToMessenger');
    expect(durableMigration).toContain('zeus_messenger_blocked_conversations');
    expect(durableMigration).toContain("message = 'zeus_messenger_e2ee_required'");
  });
});
