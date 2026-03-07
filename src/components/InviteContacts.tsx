import { useState, useCallback } from 'react';
import { Contacts } from '@capacitor-community/contacts';
import { Share } from '@capacitor/share';
import { Capacitor } from '@capacitor/core';
import { UserPlus, Search, Check, Send, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/hooks/use-toast';
import { ScrollArea } from '@/components/ui/scroll-area';

interface ParsedContact {
  id: string;
  name: string;
  phone: string;
}

const INVITE_MESSAGE = `Rejoins-moi sur Forsure, le réseau social de confiance ! 🚀\nTélécharge l'app ici : https://calm-connect-05.lovable.app`;

export function InviteContacts() {
  const [contacts, setContacts] = useState<ParsedContact[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const isNative = Capacitor.isNativePlatform();

  const loadContacts = useCallback(async () => {
    if (!isNative) {
      // On web, use share API fallback
      try {
        await navigator.share?.({
          title: 'Rejoins Forsure !',
          text: INVITE_MESSAGE,
          url: 'https://calm-connect-05.lovable.app',
        });
      } catch {
        await navigator.clipboard.writeText(INVITE_MESSAGE);
        toast({ title: 'Lien copié !', description: 'Partagez-le avec vos amis' });
      }
      return;
    }

    setLoading(true);
    try {
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
        projection: {
          name: true,
          phones: true,
        },
      });

      const parsed: ParsedContact[] = [];
      const seen = new Set<string>();

      for (const c of result.contacts) {
        const name = c.name?.display || c.name?.given || '';
        const phones = c.phones || [];
        for (const p of phones) {
          const num = p.number?.replace(/\s/g, '') || '';
          if (num && !seen.has(num)) {
            seen.add(num);
            parsed.push({
              id: `${c.contactId}-${num}`,
              name: name || num,
              phone: num,
            });
          }
        }
      }

      parsed.sort((a, b) => a.name.localeCompare(b.name));
      setContacts(parsed);
      setLoaded(true);
    } catch (err: any) {
      toast({
        title: 'Erreur',
        description: err.message || 'Impossible de charger les contacts',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [isNative]);

  const toggleContact = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(c => c.id)));
    }
  };

  const sendInvites = async () => {
    if (selected.size === 0) return;

    try {
      // On native, use Share API with the message
      await Share.share({
        title: 'Rejoins Forsure !',
        text: INVITE_MESSAGE,
        dialogTitle: 'Inviter des amis',
      });

      toast({
        title: `${selected.size} invitation(s) envoyée(s) !`,
        description: 'Vos amis recevront le lien',
      });
      setSelected(new Set());
    } catch {
      // User cancelled share
    }
  };

  const filtered = contacts.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.phone.includes(search)
  );

  // Web fallback — simple share button
  if (!isNative) {
    return (
      <div className="flex flex-col items-center justify-center p-8 gap-4 text-center">
        <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
          <UserPlus className="w-8 h-8 text-primary" />
        </div>
        <h3 className="font-semibold text-lg">Invitez vos amis</h3>
        <p className="text-sm text-muted-foreground max-w-xs">
          Partagez le lien de Forsure avec vos proches pour qu'ils rejoignent le réseau
        </p>
        <Button onClick={loadContacts} className="gap-2">
          <Send className="w-4 h-4" />
          Partager le lien
        </Button>
      </div>
    );
  }

  // Not loaded yet — show CTA
  if (!loaded) {
    return (
      <div className="flex flex-col items-center justify-center p-8 gap-4 text-center">
        <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
          <Phone className="w-8 h-8 text-primary" />
        </div>
        <h3 className="font-semibold text-lg">Invitez depuis vos contacts</h3>
        <p className="text-sm text-muted-foreground max-w-xs">
          Sélectionnez des personnes de votre répertoire pour les inviter sur Forsure
        </p>
        <Button onClick={loadContacts} disabled={loading} className="gap-2">
          {loading ? (
            <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
          ) : (
            <UserPlus className="w-4 h-4" />
          )}
          {loading ? 'Chargement...' : 'Accéder aux contacts'}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search + select all */}
      <div className="p-3 space-y-2 border-b border-border">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Rechercher un contact..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex items-center justify-between">
          <button
            onClick={selectAll}
            className="text-xs text-primary font-medium"
          >
            {selected.size === filtered.length && filtered.length > 0 ? 'Tout désélectionner' : 'Tout sélectionner'}
          </button>
          <span className="text-xs text-muted-foreground">
            {selected.size} sélectionné{selected.size > 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Contact list */}
      <ScrollArea className="flex-1">
        <div className="divide-y divide-border">
          {filtered.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">Aucun contact trouvé</p>
          ) : (
            filtered.map(contact => (
              <button
                key={contact.id}
                onClick={() => toggleContact(contact.id)}
                className="w-full flex items-center gap-3 p-3 hover:bg-muted/50 transition-colors"
              >
                <Checkbox checked={selected.has(contact.id)} />
                <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-semibold text-muted-foreground">
                  {contact.name.charAt(0).toUpperCase()}
                </div>
                <div className="text-left flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{contact.name}</p>
                  <p className="text-xs text-muted-foreground">{contact.phone}</p>
                </div>
                {selected.has(contact.id) && (
                  <Check className="w-4 h-4 text-primary shrink-0" />
                )}
              </button>
            ))
          )}
        </div>
      </ScrollArea>

      {/* Send button */}
      {selected.size > 0 && (
        <div className="p-3 border-t border-border">
          <Button onClick={sendInvites} className="w-full gap-2">
            <Send className="w-4 h-4" />
            Inviter {selected.size} personne{selected.size > 1 ? 's' : ''}
          </Button>
        </div>
      )}
    </div>
  );
}
