import { supabase } from '@/integrations/supabase/client';
import { unwrapSecurePipelineEnvelope } from './secureMessagePipeline';

export interface SealedTransportEnvelope {
  id: string;
  conversationId: string;
  anonymousSenderTag: string;
  sealedPayload: string;
  sealedHeader: Record<string, unknown>;
  createdAt: string;
}

export async function sendSealedTransportMessage(params: {
  conversationId: string;
  recipientUserId: string;
  wrappedSecurePayload: string;
}) {
  const parsed = unwrapSecurePipelineEnvelope(params.wrappedSecurePayload);
  if (!parsed) {
    throw new Error('INVALID_SECURE_PIPELINE');
  }

  const tag = parsed.meta?.sealedSender?.anonymousSenderTag;
  if (!tag) {
    throw new Error('MISSING_SEALED_SENDER_TAG');
  }

  const { data, error } = await (supabase.rpc as any)('send_sealed_sender_message', {
    p_conversation_id: params.conversationId,
    p_recipient_user_id: params.recipientUserId,
    p_anonymous_sender_tag: tag,
    p_sealed_payload: params.wrappedSecurePayload,
    p_sealed_header: {
      epoch: parsed.meta.identityEpoch,
      hasCert: !!parsed.meta.senderCertificate,
    },
  });

  if (error) throw error;
  return data as string;
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
  await (supabase.rpc as any)('mark_sealed_sender_delivered', {
    p_message_id: messageId,
  });
}
