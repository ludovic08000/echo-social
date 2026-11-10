import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import type { ZeusActivity } from '@/lib/zeusActivity';

const responseSchema = z.object({
  friendship_id: z.string().uuid(),
  requester_id: z.string().uuid(),
  decision: z.enum(['accepted', 'rejected']),
});

export type ZeusFriendRequestDecision = z.infer<typeof responseSchema>;
export type ZeusFriendRequestPreview = ZeusActivity['friend_requests_preview'][number];

function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('fr-FR').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function resolveZeusFriendRequest(activity: ZeusActivity, requestedName: string): ZeusFriendRequestPreview[] {
  const wanted = normalizeName(requestedName);
  if (!wanted) return [];
  const exact = activity.friend_requests_preview.filter(request => normalizeName(request.name) === wanted);
  if (exact.length) return exact;
  return activity.friend_requests_preview.filter(request => normalizeName(request.name).includes(wanted));
}

export async function respondToZeusFriendRequest(
  friendshipId: string,
  decision: 'accept' | 'reject',
): Promise<ZeusFriendRequestDecision> {
  const id = z.string().uuid().parse(friendshipId);
  const { data, error } = await supabase.rpc('zeus_respond_friend_request', {
    p_friendship_id: id,
    p_accept: decision === 'accept',
  });
  if (error) throw new Error('Cette demande d’ami n’est plus disponible.');
  const parsed = responseSchema.safeParse(data);
  if (!parsed.success) throw new Error('Le serveur n’a pas confirmé la réponse à la demande d’ami.');
  return parsed.data;
}

export function friendRequestProfilePath(requesterId: string): string {
  return `/profile/${z.string().uuid().parse(requesterId)}`;
}

export async function findZeusFriendRequests(name?: string): Promise<ZeusFriendRequestPreview[]> {
  const { data, error } = await supabase.rpc('zeus_pending_friend_requests', { p_name: name?.trim() });
  const parsed = z.array(z.object({ friendship_id: z.string().uuid(), requester_id: z.string().uuid(), name: z.string().min(1), avatar_url: z.string().nullable() })).max(51).safeParse(data);
  if (error || !parsed.success) throw new Error('Les demandes d’amis ne sont pas disponibles pour le moment.');
  return parsed.data;
}
