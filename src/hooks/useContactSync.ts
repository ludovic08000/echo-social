import { useState, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { Contacts } from '@capacitor-community/contacts';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from '@/hooks/use-toast';

export interface PhoneContact {
  id: string;
  name: string;
  phone: string;
}

export interface MatchedContact {
  user_id: string;
  name: string;
  avatar_url: string | null;
  phone_number: string;
  is_friend: boolean;
  contact_name: string; // name from phone
}

export interface UnmatchedContact {
  id: string;
  name: string;
  phone: string;
}

function normalizePhone(phone: string): string {
  let clean = phone.replace(/[\s\-().]/g, '');
  // Convert French local to international
  if (clean.startsWith('0') && clean.length === 10) {
    clean = '+33' + clean.slice(1);
  }
  if (!clean.startsWith('+')) {
    clean = '+' + clean;
  }
  return clean;
}

export function useContactSync() {
  const { user } = useAuth();
  const [phoneContacts, setPhoneContacts] = useState<PhoneContact[]>([]);
  const [matched, setMatched] = useState<MatchedContact[]>([]);
  const [unmatched, setUnmatched] = useState<UnmatchedContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [synced, setSynced] = useState(false);

  const isNative = Capacitor.isNativePlatform();

  const syncContacts = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    try {
      // 1. Request permission & load contacts
      if (!isNative) {
        toast({ title: 'Fonctionnalité mobile', description: 'Disponible sur l\'app iOS/Android' });
        setLoading(false);
        return;
      }

      const permission = await Contacts.requestPermissions();
      if (permission.contacts !== 'granted') {
        toast({
          title: 'Accès refusé',
          description: 'Autorisez l\'accès aux contacts dans les réglages',
          variant: 'destructive',
        });
        setLoading(false);
        return;
      }

      const result = await Contacts.getContacts({
        projection: { name: true, phones: true },
      });

      // 2. Parse & deduplicate
      const parsed: PhoneContact[] = [];
      const seen = new Set<string>();

      for (const c of result.contacts) {
        const name = c.name?.display || c.name?.given || '';
        for (const p of (c.phones || [])) {
          const raw = p.number?.replace(/\s/g, '') || '';
          const normalized = normalizePhone(raw);
          if (normalized.length >= 8 && !seen.has(normalized)) {
            seen.add(normalized);
            parsed.push({
              id: `${c.contactId}-${normalized}`,
              name: name || normalized,
              phone: normalized,
            });
          }
        }
      }

      parsed.sort((a, b) => a.name.localeCompare(b.name));
      setPhoneContacts(parsed);

      // 3. Match against DB (batch of normalized numbers)
      const phones = parsed.map(c => c.phone);
      const phoneToContact = new Map(parsed.map(c => [c.phone, c]));

      const { data: matches, error } = await supabase.rpc('match_contacts_by_phone', {
        p_user_id: user.id,
        p_phone_numbers: phones,
      });

      if (error) throw error;

      const matchedPhones = new Set<string>();
      const matchedResults: MatchedContact[] = (matches || []).map((m: any) => {
        matchedPhones.add(m.phone_number);
        const contact = phoneToContact.get(m.phone_number);
        return {
          user_id: m.user_id,
          name: m.name,
          avatar_url: m.avatar_url,
          phone_number: m.phone_number,
          is_friend: m.is_friend,
          contact_name: contact?.name || m.name,
        };
      });

      const unmatchedResults: UnmatchedContact[] = parsed.filter(
        c => !matchedPhones.has(c.phone)
      );

      setMatched(matchedResults);
      setUnmatched(unmatchedResults);
      setSynced(true);

      toast({
        title: `${matchedResults.length} contact(s) trouvé(s) sur Forsure`,
        description: unmatchedResults.length > 0
          ? `${unmatchedResults.length} contact(s) à inviter`
          : 'Tous vos contacts sont déjà sur Forsure !',
      });
    } catch (err: any) {
      toast({
        title: 'Erreur',
        description: err.message || 'Impossible de synchroniser les contacts',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [user, isNative]);

  return {
    isNative,
    loading,
    synced,
    phoneContacts,
    matched,
    unmatched,
    syncContacts,
  };
}
