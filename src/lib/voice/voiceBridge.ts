import { z } from 'zod';
import { feedControlActionSchema } from '@/lib/feedControlActions';

export const DEFAULT_VOICE_ORIGIN = 'https://voice.forsure.fans';
export const VOICE_PROPOSAL_MESSAGE = 'forsure.voice.proposal';

const publishPostSchema = z.object({
  type: z.literal('publish_post'),
  body: z.string().trim().min(1).max(5_000),
}).strict();

const sendMessageSchema = z.object({
  type: z.literal('send_message'),
  conversation_id: z.string().uuid().optional(),
  recipient_name: z.string().trim().min(1).max(120).optional(),
  message_text: z.string().trim().min(1).max(10_000),
}).strict().superRefine((proposal, context) => {
  if (!proposal.conversation_id && !proposal.recipient_name) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Un destinataire est requis.' });
  }
});

export const voiceProposalSchema = z.union([
  publishPostSchema,
  sendMessageSchema,
  feedControlActionSchema,
]);

export type VoiceProposal = z.infer<typeof voiceProposalSchema>;

const voiceMessageSchema = z.object({
  type: z.literal(VOICE_PROPOSAL_MESSAGE),
  nonce: z.string().min(32).max(128),
  proposal: voiceProposalSchema,
}).strict();

export function normalizeVoiceOrigin(raw?: string): string {
  const candidate = raw?.trim() || DEFAULT_VOICE_ORIGIN;
  const url = new URL(candidate);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Origine Voice invalide');
  }
  return url.origin;
}

export function createVoiceLaunchUrl(origin: string, ticket: string, nonce: string): string {
  const url = new URL(normalizeVoiceOrigin(origin));
  const fragment = new URLSearchParams({ ticket, nonce });
  url.hash = fragment.toString();
  return url.toString();
}

export function parseVoiceProposalEvent(
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  expected: { origin: string; source: Window | null; nonce: string },
): VoiceProposal | null {
  if (!expected.source || event.origin !== normalizeVoiceOrigin(expected.origin) || event.source !== expected.source) return null;
  const parsed = voiceMessageSchema.safeParse(event.data);
  if (!parsed.success || parsed.data.nonce !== expected.nonce) return null;
  return parsed.data.proposal;
}

export function voiceProposalToZeusContent(proposal: VoiceProposal): string {
  const summary = proposal.type === 'send_message'
    ? `Message vocal préparé pour ${proposal.recipient_name || 'ce contact'}. Vérifiez puis confirmez l’envoi.`
    : proposal.type === 'publish_post'
      ? 'Publication vocale préparée. Vérifiez puis confirmez sa publication.'
      : 'Réglage vocal du feed préparé. Vérifiez puis confirmez la modification.';
  return `${summary}\n\n\`\`\`forsure-action\n${JSON.stringify(proposal)}\n\`\`\``;
}
