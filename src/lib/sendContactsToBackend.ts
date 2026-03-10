import type { ForgeContact } from '@/plugins/contacts';
import { supabase } from '@/integrations/supabase/client';

export async function sendContactsToBackend(contacts: ForgeContact[]) {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error('Non authentifié');
  }

  const response = await supabase.functions.invoke('contact-match', {
    body: {
      contacts: contacts.map((c) => ({
        phoneNumbers: c.phoneNumbers,
        emails: c.emails,
      })),
    },
  });

  if (response.error) {
    throw new Error('Échec envoi contacts');
  }

  return response.data;
}
