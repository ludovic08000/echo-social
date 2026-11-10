import { supabase } from '@/integrations/supabase/client';

export interface ZeusRecipient { user_id: string; name: string; avatar_url?:string|null; friendship_id?:string; }
const normalize = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function selectZeusRecipients(people: ZeusRecipient[], name: string): ZeusRecipient[] {
  const wanted=normalize(name);
  if (!wanted) return [];
  const unique=[...new Map(people.map(person=>[person.user_id,person])).values()];
  const exact=unique.filter(person=>normalize(person.name)===wanted);
  return exact.length ? exact : unique.filter(person=>normalize(person.name).split(' ').some((_,i,parts)=>parts.slice(i).join(' ').startsWith(wanted)));
}
export async function findZeusRecipients(name: string): Promise<ZeusRecipient[]> {
  const {data:{user},error:authError}=await supabase.auth.getUser();
  if(authError||!user) throw new Error('Reconnectez-vous pour choisir un destinataire.');
  if (!name.trim() || name.length>120) throw new Error('Précisez le nom complet du destinataire.');
  const {data,error}=await supabase.rpc('zeus_find_contacts',{p_name:name.trim()});
  if(error)throw new Error('La recherche du destinataire est indisponible.');
  if((data?.length??0)>20)throw new Error('Plusieurs personnes correspondent. Précisez le nom et le prénom.');
  return selectZeusRecipients((data??[]).filter(person=>typeof person.name==='string'),name);
}
