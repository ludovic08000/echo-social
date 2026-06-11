// Lot A2 — Sealed Sender REAL transport.
//
// Outbound:
//  1) Mint a delivery token via `sealed-mint-token` (JWT-authed). Server
//     stores ONLY the token hash and forgets who minted it.
//  2) POST the sealed payload to `sealed-relay` WITHOUT auth header. Server
//     can no longer link auth.uid() → row.
// Inbound: regular RLS read on `sealed_sender_messages` (recipient only).
//
// Replaces the old "RPC theatre" path which used auth.uid() and made the
// sender→row link trivially recoverable from server logs.

import { supabase } from '@/integrations/supabase/client';
import { unwrapSecurePipelineEnvelope } from './secureMessagePipeline';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

export interface SealedTransportEnvelope {
  id: string;
  conversationId: string;
  anonymousSenderTag: string;
  sealedPayload: string;
  sealedHeader: Record<string, unknown>;
  createdAt: string;
}

interface MintedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: { recipient: string; minted: MintedToken } | null = null;

async function mintTokenFor(recipient: string): Promise<MintedToken> {
  if (cachedToken && cachedToken.recipient === recipient && cachedToken.minted.expiresAt - 30_000 > Date.now()) {
    return cachedToken.minted;
  }

  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('NOT_AUTHENTICATED');

  const res = await fetch(`${SUPABASE_URL}/functions/v1/sealed-mint-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': ANON_KEY,
    },
    body: JSON.stringify({ recipient_user_id: recipient }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MINT_FAILED:${res.status}:${body}`);
  }
  const json = await res.json() as { token: string; expires_at: number };
  const minted: MintedToken = { token: json.token, expiresAt: Number(json.expires_at) };
  cachedToken = { recipient, minted };
  return minted;
}

export async function sendSealedTransportMessage(params: {
  conversationId: string;
  recipientUserId: string;
  wrappedSecurePayload: string;
}): Promise<string> {
  const parsed = unwrapSecurePipelineEnvelope(params.wrappedSecurePayload);
  if (!parsed) throw new Error('INVALID_SECURE_PIPELINE');

  const tag = (parsed.meta as any)?.sealedSender?.anonymousSenderTag;
  if (!tag) throw new Error('MISSING_SEALED_SENDER_TAG');

  const minted = await mintTokenFor(params.recipientUserId);

  // Note: NO Authorization header on purpose — relay must NOT see auth.uid.
  const res = await fetch(`${SUPABASE_URL}/functions/v1/sealed-relay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': ANON_KEY,
    },
    body: JSON.stringify({
      token: minted.token,
      conversation_id: params.conversationId,
      anonymous_sender_tag: tag,
      sealed_payload: params.wrappedSecurePayload,
      sealed_header: {
        epoch: (parsed.meta as any).identityEpoch,
        hasCert: !!(parsed.meta as any).senderCertificate,
      },
    }),
  });

  if (!res.ok) {
    cachedToken = null; // burn cache on failure
    const body = await res.text().catch(() => '');
    throw new Error(`SEALED_RELAY_FAILED:${res.status}:${body}`);
  }
  cachedToken = null; // single-use anyway
  const json = await res.json() as { id: string };
  return json.id;
}

export async function fetchIncomingSealedTransportMessages(): Promise<SealedTransportEnvelope[]> {
  const { data, error } = await supabase
    .from('sealed_sender_messages' as any)
    .select('id, conversation_id, anonymous_sender_tag, sealed_payload, sealed_header, created_at')
    .order('created_at', { ascending: true });

  if (error) throw error;

  return ((data || []) as any[]).map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    anonymousSenderTag: row.anonymous_sender_tag,
    sealedPayload: row.sealed_payload,
    sealedHeader: row.sealed_header || {},
    createdAt: row.created_at,
  }));
}

export async function markSealedTransportDelivered(messageId: string): Promise<void> {
  await supabase
    .from('sealed_sender_messages' as any)
    .update({ delivery_state: 'delivered', delivered_at: new Date().toISOString() })
    .eq('id', messageId);
}
