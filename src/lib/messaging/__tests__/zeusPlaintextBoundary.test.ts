import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260806233500_remove_zeus_plaintext_messenger.sql',
  'utf8',
);
const messagesHook = readFileSync('src/hooks/useMessages.ts', 'utf8');
const agentChat = readFileSync('supabase/functions/agent-chat/index.ts', 'utf8');

describe('Zeus plaintext boundary', () => {
  it('keeps future Zeus welcomes outside the regular messenger', () => {
    expect(migration).toContain('create or replace function public.zeus_welcome_new_user()');
    expect(migration).toContain('anonymous_wall_messages');

    const welcomeFunction = migration.slice(
      migration.indexOf('create or replace function public.zeus_welcome_new_user()'),
      migration.indexOf('create or replace function public.reject_zeus_messenger_participant()'),
    );
    expect(welcomeFunction).not.toContain('insert into public.messages');
    expect(welcomeFunction).not.toContain('insert into public.conversations');
  });

  it('rejects Zeus participants and messages at the database boundary', () => {
    expect(migration).toContain('reject_zeus_messenger_participant_trigger');
    expect(migration).toContain('reject_zeus_messenger_message_trigger');
    expect(migration).toContain("new.sender_id = '00000000-0000-0000-0000-000000000001'::uuid");
    expect(migration).toContain('return null;');
  });

  it('removes historical plaintext rows and detaches Zeus conversations', () => {
    expect(migration).toContain('create temporary table zeus_messenger_conversations');
    expect(migration).toContain('delete from public.messages');
    expect(migration).toContain('delete from public.conversation_participants');
  });

  it('documents every legacy caller guarded by the database invariant', () => {
    expect(messagesHook).toContain('sendToZeus');
    expect(agentChat).toContain('pushToMessenger');
    expect(migration).toContain('A legacy caller may create a conversation');
  });
});
