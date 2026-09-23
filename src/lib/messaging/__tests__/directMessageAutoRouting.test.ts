import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260923154043_direct_message_auto_routing.sql',
  'utf8',
).toLowerCase();
const messagesHook = readFileSync('src/hooks/useMessages.ts', 'utf8');
const chatWidget = readFileSync('src/components/ChatWidget.tsx', 'utf8');

describe('direct message auto-routing', () => {
  it('delivers adult direct messages without a friendship request queue', () => {
    expect(migration).toContain('drop trigger if exists check_message_friendship_trigger');
    expect(migration).toContain('drop function if exists public.check_message_friendship()');
    expect(migration).toContain('create or replace function public.route_direct_message_delivery()');
    expect(migration).toContain("new.status := 'delivered'");
    expect(migration).not.toContain("new.status := 'pending'");
  });

  it('preserves the non-friend-to-minor safety boundary', () => {
    expect(migration).toContain('public.is_user_minor(v_recipient_id)');
    expect(migration).toContain("new.status := 'blocked'");
    expect(migration).toContain("f.status = 'accepted'");
  });

  it('migrates historical requests and removes the request UI', () => {
    expect(migration).toContain("where m.status = 'pending'");
    expect(migration).toContain("set status = 'delivered'");
    expect(messagesHook).not.toContain("['delivered', 'pending']");
    expect(messagesHook).not.toContain('useHasPendingMessages');
    expect(messagesHook).not.toContain('useAcceptMessageRequest');
    expect(messagesHook).not.toContain('useRejectMessageRequest');
    expect(chatWidget).not.toContain('Demande de message');
    expect(chatWidget).not.toContain('useHasPendingMessages');
  });

  it('has no parallel legacy DeviceID implementation left in the client', () => {
    expect(existsSync('src/lib/e2eeCleanStartup.ts')).toBe(false);
    expect(existsSync('src/lib/crypto/deviceList.ts')).toBe(false);
    expect(existsSync('src/lib/crypto/deviceTrust.ts')).toBe(false);
  });
});
