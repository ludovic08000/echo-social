import { expect,it } from 'vitest';
import { selectZeusRecipients } from '@/lib/zeusRecipients';
import { voiceConfirmation,zeusCommandSchema } from '@/lib/zeusCommands';
const people=[{user_id:'a',name:'Nadège Loynet'},{user_id:'b',name:'Nadège Dupont'}];
it('never chooses the first homonym and accepts the spoken full name without accents',()=>{
  expect(selectZeusRecipients(people,'nadege')).toHaveLength(2);
  expect(selectZeusRecipients(people,'nadege loynet')).toEqual([people[0]]);
});
it.each(['oui','je confirme','oui je confirme','vas-y'])('accepts an explicit confirmation: %s',text=>expect(voiceConfirmation(text)).toBe('confirm'));
it.each(['oui mais change le texte','ne publie pas','je confirme pas','peut être','non merci'])('does not treat an ambiguous or negative phrase as confirmation: %s',text=>expect(voiceConfirmation(text)).not.toBe('confirm'));
it('rejects incomplete message and call proposals before execution',()=>{
  expect(zeusCommandSchema.safeParse({type:'send_message',message_text:'Salut'}).success).toBe(false);
  expect(zeusCommandSchema.safeParse({type:'start_call',recipient_name:'Nadège',call_type:'invented'}).success).toBe(false);
});
