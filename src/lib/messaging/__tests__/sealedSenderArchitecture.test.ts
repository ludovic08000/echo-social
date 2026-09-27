import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mint = readFileSync('supabase/functions/sealed-mint-token/index.ts', 'utf8');
const relay = readFileSync('supabase/functions/sealed-relay/index.ts', 'utf8');
const token = readFileSync('supabase/functions/_shared/sealedSenderToken.ts', 'utf8');
const client = readFileSync('src/lib/messaging/sealedSenderTransport.ts', 'utf8');
const migration = readFileSync(
  'supabase/migrations/20260927172452_enable_sealed_sender_transport.sql',
  'utf8',
);

describe('Sealed Sender transport architecture', () => {
  it('authenticates minting but omits the sender identity from token and relay storage', () => {
    for (const field of ['version', 'recipient_user_id', 'conversation_id', 'nonce', 'issued_at', 'expires_at']) {
      expect(mint).toContain(field);
    }
    expect(mint).toContain("from('conversation_participants')");
    expect(mint).toContain("from('conversations')");
    expect(token).not.toContain('sender_user_id');
    expect(relay).not.toContain('p_sender_user_id');
  });

  it('pins the Edge Function SDK dependency to a reviewed version', () => {
    const pinnedImport = "https://esm.sh/@supabase/supabase-js@2.45.4";
    expect(mint).toContain(pinnedImport);
    expect(relay).toContain(pinnedImport);
    expect(mint).not.toContain("@supabase/supabase-js@2';");
    expect(relay).not.toContain("@supabase/supabase-js@2';");
  });

  it('fails closed when the token secret is missing or shorter than 32 UTF-8 bytes', () => {
    for (const edgeFunction of [mint, relay]) {
      expect(edgeFunction).toContain("Deno.env.get('SEALED_SENDER_TOKEN_SECRET')");
      expect(edgeFunction).toContain('utf8ByteLength(tokenSecret) < 32');
      expect(edgeFunction).toContain("error: 'sealed_sender_unavailable'");
    }
    expect(mint).toContain('!isUuid(body.context_id)');
  });

  it('validates exact relay context and size limits before the service-role RPC', () => {
    expect(relay).toContain('conversation_mismatch');
    expect(relay).toContain('recipient_mismatch');
    expect(relay).toContain('SEALED_SENDER_MAX_HEADER_BYTES');
    expect(relay).toContain('SEALED_SENDER_MAX_PAYLOAD_BYTES');
    expect(relay).toContain("rpc('relay_sealed_sender'");
  });

  it('relays without the authenticated session and retains the canonical fallback', () => {
    expect(client).toContain("functions.invoke('sealed-mint-token'");
    expect(client).toContain('/functions/v1/sealed-relay');
    expect(client).toContain('apikey: publishableKey');
    expect(client).not.toContain("Authorization:");
    expect(client).toContain('Failure is intentionally non-fatal');
  });

  it('removes direct insertion and makes consume+insert one idempotent transaction', () => {
    expect(migration).toContain('drop policy if exists "sealed messages authenticated insert"');
    expect(migration).toContain('for update');
    expect(migration).toContain('delete from public.sealed_sender_tokens');
    expect(migration).toContain('from public.messages message');
    expect(migration).toContain('from public.aegis_device_inbox inbox');
    expect(migration).toContain("raise exception 'recipient_not_targeted'");
    expect(migration).toContain('insert into public.sealed_sender_messages');
    expect(migration).toContain('on conflict (recipient_user_id, context_id)');
    expect(migration).toContain('grant execute on function public.relay_sealed_sender');
    expect(migration).toContain('to service_role');
  });
});
