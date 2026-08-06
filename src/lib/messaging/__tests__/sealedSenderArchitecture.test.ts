import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mint = readFileSync('supabase/functions/sealed-mint-token/index.ts', 'utf8');
const relay = readFileSync('supabase/functions/sealed-relay/index.ts', 'utf8');
const migration = readFileSync(
  'supabase/migrations/20260806230000_sealed_sender_v1_atomic_relay.sql',
  'utf8',
);

describe('Sealed Sender v1 architecture', () => {
  it('binds the token to sender, recipient, conversation, version, nonce and time', () => {
    for (const field of ['version', 'sender_user_id', 'recipient_user_id', 'conversation_id', 'nonce', 'issued_at', 'expires_at']) {
      expect(mint).toContain(field);
    }
    expect(mint).toContain("from('conversation_participants')");
    expect(mint).toContain("from('conversations')");
  });

  it('pins the Edge Function SDK dependency to a reviewed version', () => {
    const pinnedImport = "https://esm.sh/@supabase/supabase-js@2.45.4";
    expect(mint).toContain(pinnedImport);
    expect(relay).toContain(pinnedImport);
    expect(mint).not.toContain("@supabase/supabase-js@2';");
    expect(relay).not.toContain("@supabase/supabase-js@2';");
  });

  it('validates exact relay context and size limits before the service-role RPC', () => {
    expect(relay).toContain('conversation_mismatch');
    expect(relay).toContain('recipient_mismatch');
    expect(relay).toContain('SEALED_SENDER_MAX_HEADER_BYTES');
    expect(relay).toContain('SEALED_SENDER_MAX_PAYLOAD_BYTES');
    expect(relay).toContain("rpc('relay_sealed_sender_v1'");
  });

  it('removes direct authenticated insertion and makes consume+insert one transaction', () => {
    expect(migration).toContain('drop policy if exists "sealed messages authenticated insert"');
    expect(migration).toContain('for update');
    expect(migration).toContain('set consumed_at = statement_timestamp()');
    expect(migration).toContain('insert into public.sealed_sender_messages');
    expect(migration).toContain('grant execute on function public.relay_sealed_sender_v1');
    expect(migration).toContain('to service_role');
  });
});
