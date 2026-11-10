import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';

export const zeusActivitySchema = z.object({
  unread_messages: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  unread_notifications: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  publication_replies: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  friend_requests: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  friend_requests_preview: z.array(z.object({
    friendship_id: z.string().uuid(),
    requester_id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    avatar_url: z.string().url().nullable(),
  })).max(5).default([]),
  checked_at: z.string().refine(value => Number.isFinite(Date.parse(value))),
});
export type ZeusActivity = z.infer<typeof zeusActivitySchema>;

export async function loadZeusActivity(expectedUserId?:string): Promise<ZeusActivity> {
  const assertActor=async()=>{
    if(!expectedUserId)return;
    const current=await supabase.auth.getSession();
    if(current.data.session?.user.id!==expectedUserId)throw new Error('Le compte connecté a changé pendant la lecture du bilan.');
  };
  await assertActor();
  const { data, error } = await supabase.rpc('zeus_activity_summary');
  await assertActor();
  if (error) throw new Error('Le bilan de votre compte est momentanément indisponible.');
  const parsed = zeusActivitySchema.safeParse(data);
  if (!parsed.success) throw new Error('Le serveur n’a pas confirmé les compteurs de votre compte.');
  return parsed.data;
}

export function formatZeusActivity(activity: ZeusActivity): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const messages = plural(activity.unread_messages, 'message non lu', 'messages non lus');
  const notifications = plural(activity.unread_notifications, 'notification non lue', 'notifications non lues');
  const replies = plural(activity.publication_replies, 'réponse non lue à tes publications', 'réponses non lues à tes publications');
  const friends = plural(activity.friend_requests, 'demande d’ami en attente', 'demandes d’amis en attente');
  const requestNames = activity.friend_requests_preview.map(request => request.name);
  const friendDetail = requestNames.length === 0 ? '' : requestNames.length === 1
    ? ` La demande vient de ${requestNames[0]}. Tu peux me demander d’afficher son profil avant de répondre.`
    : ` Les demandes les plus récentes viennent de ${requestNames.join(', ')}. Tu peux me demander d’afficher un profil avant de répondre.`;
  return `Tu as ${messages} et ${notifications}, dont ${replies}. Tu as aussi ${friends}.${friendDetail}`;
}

export function isZeusActivityQuestion(text: string): boolean {
  const normalized = text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  if(/\b(caracteres|mots|lettres|taille du texte|lignes)\b/.test(normalized))return false;
  return /\b(combien|bilan|resume|mes notifications|mes messages|du nouveau|quoi de neuf|des reponses|a repondu|ont repondu)\b/.test(normalized)
    && /\b(message|messages|notification|notifications|publication|publications|reponse|reponses|nouveau|neuf|bilan)\b/.test(normalized)
    && !/\b(envoie|envoyer|publie|publier|appelle|appeler)\b/.test(normalized);
}
