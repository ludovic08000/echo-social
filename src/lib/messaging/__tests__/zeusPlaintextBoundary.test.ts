import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const initialMigration = readFileSync(
  'supabase/migrations/20260806232000_block_plaintext_zeus_messaging.sql',
  'utf8',
);
const durableMigration = readFileSync(
  'supabase/migrations/20260806233500_remove_zeus_plaintext_messenger.sql',
  'utf8',
);
const sqlSecurityTest = readFileSync(
  'supabase/tests/zeus_plaintext_messaging.sql',
  'utf8',
);
const messagesHook = readFileSync('src/hooks/useMessages.ts', 'utf8');
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
    expect(sqlSecurityTest).toContain("t.tgname = 'reject_plaintext_zeus_messenger'");
    expect(sqlSecurityTest).toContain("to_regprocedure('public.reject_zeus_messenger_participant()')");
    expect(sqlSecurityTest).toContain("t.tgname = 'reject_zeus_messenger_participant'");
  });

  it('rejects legacy plaintext paths at the database boundary', () => {
    expect(durableMigration).toContain("new.sender_id = '00000000-0000-0000-0000-000000000001'::uuid");
    expect(durableMigration).toContain("message = 'zeus_messenger_e2ee_required'");
    expect(durableMigration).toContain('return null;');
  });

  it('detaches historical Zeus conversations from the normal messenger', () => {
    expect(durableMigration).toContain('delete from public.conversation_participants');
    expect(durableMigration).toContain('from public.zeus_messenger_blocked_conversations blocked');
  });

  it('documents every legacy caller currently guarded by the database invariant', () => {
    expect(messagesHook).toContain('sendToZeus');
    expect(agentChat).toContain('pushToMessenger');
    expect(durableMigration).toContain('legacy caller');
  });
});
