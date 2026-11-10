import { z } from 'zod';
import { feedControlActionSchema } from '@/lib/feedControlActions';
export const zeusCommandSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('publish_post'),body:z.string().trim().min(1).max(5000),image_prompt:z.string().max(1000).nullable().optional()}),
  z.object({type:z.literal('send_message'),recipient_name:z.string().trim().min(1).max(120),message_text:z.string().trim().min(1).max(10000)}),
  z.object({type:z.literal('start_call'),recipient_name:z.string().trim().min(1).max(120),call_type:z.enum(['audio','video'])}),
  z.object({type:z.literal('read_activity')}),
  feedControlActionSchema,
  z.object({type:z.literal('list_friend_requests')}),
  z.object({type:z.literal('show_friend_request_profile'),requester_name:z.string().trim().min(1).max(120)}),
  z.object({type:z.literal('respond_friend_request'),requester_name:z.string().trim().min(1).max(120),decision:z.enum(['accept','reject'])}),
  z.object({
    type:z.literal('update_feed_appearance'),
    font_family:z.enum(['system','inter','georgia','comic','mono','poppins','playfair']).optional(),
    text_color:z.enum(['','#FFFFFF','#1a1a2e','#e0c3fc','#ffd6e0','#c9f0ff','#d4fc79','#ffeaa7']).optional(),
    background_color:z.enum(['','#0d0d1a','#1a1025','#f8f0ff','#fff0f5','#f0f9ff','#fefce8','#f5f5f4','#1c1917']).optional(),
  }).refine(value=>value.font_family!==undefined||value.text_color!==undefined||value.background_color!==undefined,{message:'Au moins un réglage d’apparence est requis.'}),
]);
export type ZeusCommand=z.infer<typeof zeusCommandSchema>;
export function voiceConfirmation(text:string):'confirm'|'cancel'|null {
  const value=text.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/[^a-z ]/g,' ').replace(/\s+/g,' ').trim();
  if(/^(non|annule|annuler|stop|laisse tomber|ne fais rien)$/.test(value))return 'cancel';
  if(/^(oui|oui je confirme|je confirme|confirme|confirmer|vas y|oui vas y|d accord|ok confirme)$/.test(value))return 'confirm';
  return null;
}
