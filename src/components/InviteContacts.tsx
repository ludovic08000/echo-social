import { useState, useRef } from 'react';
import { Share } from '@capacitor/share';
import { UserPlus, Search, Check, Send, Phone, Users, ArrowRight, Upload, FileText, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/hooks/use-toast';
import { ScrollArea } from '@/components/ui/scroll-area';
import { UserAvatar } from '@/components/UserAvatar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useContactSync, MatchedContact, UnmatchedContact } from '@/hooks/useContactSync';
import { useSendFriendRequest } from '@/hooks/useFriendships';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

const INVITE_MESSAGE = `Rejoins-moi sur Forsure, le réseau social de confiance ! 🚀\nTélécharge l'app ici : https://forsure.fans`;

function normalizePhone(phone: string): string {
  let clean = phone.replace(/[\s\-().]/g, '');
  if (clean.startsWith('0') && clean.length === 10) {
    clean = '+33' + clean.slice(1);
  }
  if (!clean.startsWith('+')) {
    clean = '+' + clean;
  }
  return clean;
}

interface VCardContact {
  name: string;
  phone: string;
}

/** Parse contacts (name + phone) from a vCard (.vcf) file */
function parseVCardContacts(vcfContent: string): VCardContact[] {
  const contacts: VCardContact[] = [];
  const seen = new Set<string>();
  
  // Split by vCard entries
  const entries = vcfContent.split(/(?=BEGIN:VCARD)/i);
  
  for (const entry of entries) {
    if (!entry.trim()) continue;
    
    // Extract name (FN preferred, fallback to N)
    const fnMatch = entry.match(/^FN[^:]*:(.+)$/im);
    const nMatch = entry.match(/^N[^:]*:([^;]*);([^;]*)/im);
    let name = '';
    if (fnMatch) {
      name = fnMatch[1].trim();
    } else if (nMatch) {
      name = `${nMatch[2]?.trim() || ''} ${nMatch[1]?.trim() || ''}`.trim();
    }
    
    // Extract phone numbers
    const telRegex = /^(?:item\d+\.)?TEL[^:]*:(.+)$/gim;
    let telMatch;
    while ((telMatch = telRegex.exec(entry)) !== null) {
      const raw = telMatch[1].trim().replace(/[\s\-().]/g, '');
      if (raw.length >= 6) {
        const normalized = normalizePhone(raw);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          contacts.push({
            name: name || normalized,
            phone: normalized,
          });
        }
      }
    }
  }
  
  console.log('[VCF] Parsed contacts:', contacts.length, contacts.slice(0, 5));
  return contacts;
}

/** Legacy: parse just phone numbers */
function parseVCardPhones(vcfContent: string): string[] {
  return parseVCardContacts(vcfContent).map(c => c.phone);
}

/** Check if Contact Picker API is available (not supported on iOS Safari) */
function hasContactPicker(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) return false;
  return 'contacts' in navigator && 'ContactsManager' in window;
}

function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Web fallback: contact picker, vCard import, or manual phone search */
function WebPhoneSearch() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const sendRequest = useSendFriendRequest();
  const [phoneInput, setPhoneInput] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<MatchedContact[]>([]);
  const [unmatchedContacts, setUnmatchedContacts] = useState<VCardContact[]>([]);
  const [searched, setSearched] = useState(false);
  const [sentRequests, setSentRequests] = useState<Set<string>>(new Set());
  const [selectedInvites, setSelectedInvites] = useState<Set<string>>(new Set());
  const [pickerSupported] = useState(hasContactPicker);
  const [isIOS] = useState(isIOSDevice);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const searchPhonesWithContacts = async (vcContacts: VCardContact[]) => {
    if (!user || vcContacts.length === 0) return;
    setSearching(true);
    setSearched(false);
    try {
      const phones = vcContacts.map(c => c.phone);
      // Limit to 500 per batch
      const batch = phones.slice(0, 500);
      const { data: matches, error } = await supabase.rpc('match_contacts_by_phone', {
        p_user_id: user.id,
        p_phone_numbers: batch,
      });
      if (error) throw error;
      const matchedResults: MatchedContact[] = (matches || []).map((m: any) => ({
        user_id: m.user_id,
        name: m.name,
        avatar_url: m.avatar_url,
        phone_number: m.phone_number,
        is_friend: m.is_friend,
        contact_name: m.name,
      }));
      setResults(matchedResults);

      // Build unmatched list
      const matchedPhones = new Set((matches || []).map((m: any) => m.phone_number));
      const unmatched = vcContacts.filter(c => !matchedPhones.has(c.phone));
      setUnmatchedContacts(unmatched);
      setSearched(true);

      if (matchedResults.length > 0) {
        toast({ title: `${matchedResults.length} contact(s) trouvé(s) sur Forsure !` });
      } else {
        toast({
          title: `${unmatched.length} contact(s) à inviter`,
          description: 'Aucun de vos contacts n\'est encore sur Forsure',
        });
      }
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    } finally {
      setSearching(false);
    }
  };

  const handlePickContacts = async () => {
    try {
      const contacts = await (navigator as any).contacts.select(
        ['tel', 'name'],
        { multiple: true }
      );
      const vcContacts: VCardContact[] = [];
      for (const c of contacts) {
        for (const tel of (c.tel || [])) {
          const clean = tel.replace(/[\s\-().]/g, '');
          if (clean.length >= 6) {
            vcContacts.push({
              name: c.name?.[0] || clean,
              phone: normalizePhone(clean),
            });
          }
        }
      }
      if (vcContacts.length === 0) {
        toast({ title: 'Aucun numéro', description: 'Les contacts sélectionnés n\'ont pas de numéro' });
        return;
      }
      await searchPhonesWithContacts(vcContacts);
    } catch {
      // User cancelled picker
    }
  };

  const handleVCardImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const vcContacts = parseVCardContacts(text);
      if (vcContacts.length === 0) {
        toast({ title: 'Aucun numéro trouvé', description: 'Le fichier ne contient pas de numéros valides' });
        return;
      }
      toast({ title: `${vcContacts.length} contact(s) détecté(s)`, description: 'Analyse en cours...' });
      await searchPhonesWithContacts(vcContacts);
    } catch {
      toast({ title: 'Erreur de lecture', description: 'Impossible de lire le fichier', variant: 'destructive' });
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleManualSearch = async () => {
    if (!phoneInput.trim()) return;
    const rawNumbers = phoneInput
      .split(/[,\n;]+/)
      .map(n => n.trim())
      .filter(n => n.length >= 6);
    const vcContacts = rawNumbers.map(p => ({ name: p, phone: normalizePhone(p) }));
    await searchPhonesWithContacts(vcContacts);
  };

  const handleAddFriend = async (userId: string) => {
    try {
      await sendRequest.mutateAsync(userId);
      setSentRequests(prev => new Set(prev).add(userId));
      toast({ title: '🤝 Demande envoyée !' });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const toggleInvite = (phone: string) => {
    setSelectedInvites(prev => {
      const next = new Set(prev);
      if (next.has(phone)) next.delete(phone);
      else next.add(phone);
      return next;
    });
  };

  const sendInvitesSMS = async () => {
    if (selectedInvites.size === 0) return;
    const phones = Array.from(selectedInvites);

    if (phones.length === 1) {
      // Single contact: open SMS directly
      const isApple = /iPhone|iPad|iPod|Mac/i.test(navigator.userAgent);
      const separator = isApple ? '&' : '?';
      window.open(`sms:${phones[0]}${separator}body=${encodeURIComponent(INVITE_MESSAGE)}`, '_self');
      toast({
        title: `📱 SMS préparé`,
        description: 'L\'app SMS va s\'ouvrir',
      });
    } else {
      // Multiple contacts: copy message + all numbers to clipboard
      const textToCopy = `${INVITE_MESSAGE}\n\n📋 Numéros à inviter (${phones.length}) :\n${phones.join('\n')}`;
      try {
        await navigator.clipboard.writeText(textToCopy);
        toast({
          title: `✅ Copié ! ${phones.length} numéros + message`,
          description: 'Collez dans votre app SMS ou Messages pour envoyer à tous',
        });
      } catch {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = textToCopy;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast({
          title: `✅ Copié ! ${phones.length} numéros + message`,
          description: 'Collez dans votre app SMS ou Messages',
        });
      }
    }
  };

  const sendInvitesShare = async () => {
    if (selectedInvites.size === 0) return;
    try {
      await Share.share({
        title: 'Rejoins Forsure !',
        text: INVITE_MESSAGE,
        dialogTitle: 'Inviter des amis',
      });
      toast({
        title: `Invitation partagée !`,
        description: 'Vos amis recevront le lien',
      });
    } catch {
      try {
        await navigator.clipboard.writeText(INVITE_MESSAGE);
        toast({ title: 'Lien copié !', description: 'Collez-le dans un SMS ou une messagerie' });
      } catch {
        // ignore
      }
    }
  };

  const inviteAll = () => {
    setSelectedInvites(new Set(unmatchedContacts.map(c => c.phone)));
  };

  // After search: show results in tabs
  if (searched) {
    return (
      <div className="flex flex-col h-full">
        <Tabs defaultValue={results.length > 0 ? 'found' : 'invite'} className="flex-1 flex flex-col">
          <TabsList className="grid grid-cols-2 mx-3 mt-2">
            <TabsTrigger value="found" className="text-xs">
              Sur Forsure ({results.length})
            </TabsTrigger>
            <TabsTrigger value="invite" className="text-xs">
              À inviter ({unmatchedContacts.length})
            </TabsTrigger>
          </TabsList>

          {/* Matched contacts */}
          <TabsContent value="found" className="flex-1 mt-0">
            <ScrollArea className="h-[400px]">
              <div className="divide-y divide-border">
                {results.length === 0 ? (
                  <p className="p-6 text-center text-sm text-muted-foreground">
                    Aucun contact trouvé sur Forsure
                  </p>
                ) : (
                  results.map(contact => (
                    <div key={contact.user_id} className="flex items-center gap-3 p-3">
                      <button onClick={() => navigate(`/profile/${contact.user_id}`)} className="shrink-0">
                        <UserAvatar src={contact.avatar_url} alt={contact.name} size="md" />
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{contact.name}</p>
                        <p className="text-xs text-muted-foreground">Sur Forsure</p>
                      </div>
                      {contact.is_friend ? (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Check className="w-3.5 h-3.5 text-primary" /> Ami
                        </span>
                      ) : sentRequests.has(contact.user_id) ? (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Check className="w-3.5 h-3.5" /> Envoyé
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleAddFriend(contact.user_id)}
                          disabled={sendRequest.isPending}
                          className="gap-1 text-xs"
                        >
                          <UserPlus className="w-3.5 h-3.5" />
                          Ajouter
                        </Button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Unmatched contacts to invite */}
          <TabsContent value="invite" className="flex-1 mt-0">
            <ScrollArea className="h-[350px]">
              <div className="px-3 py-2 flex justify-between items-center">
                <button
                  onClick={() => {
                    if (selectedInvites.size === unmatchedContacts.length) {
                      setSelectedInvites(new Set());
                    } else {
                      inviteAll();
                    }
                  }}
                  className="text-xs text-primary font-medium"
                >
                  {selectedInvites.size === unmatchedContacts.length && unmatchedContacts.length > 0
                    ? 'Tout désélectionner'
                    : 'Tout sélectionner'}
                </button>
                <span className="text-xs text-muted-foreground">
                  {selectedInvites.size} sélectionné{selectedInvites.size > 1 ? 's' : ''}
                </span>
              </div>
              <div className="divide-y divide-border">
                {unmatchedContacts.length === 0 ? (
                  <p className="p-6 text-center text-sm text-muted-foreground">
                    Tous vos contacts sont sur Forsure ! 🎉
                  </p>
                ) : (
                  unmatchedContacts.map(contact => (
                    <button
                      key={contact.phone}
                      onClick={() => toggleInvite(contact.phone)}
                      className="w-full flex items-center gap-3 p-3 hover:bg-muted/50 transition-colors"
                    >
                      <Checkbox checked={selectedInvites.has(contact.phone)} />
                      <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-semibold text-muted-foreground">
                        {contact.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="text-left flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{contact.name}</p>
                        <p className="text-xs text-muted-foreground">{contact.phone}</p>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>

            {selectedInvites.size > 0 && (
              <div className="p-3 border-t border-border flex gap-2">
                <Button onClick={sendInvitesSMS} className="flex-1 gap-2">
                  <Phone className="w-4 h-4" />
                  SMS ({selectedInvites.size})
                </Button>
                <Button onClick={sendInvitesShare} variant="outline" className="flex-1 gap-2">
                  <Send className="w-4 h-4" />
                  Partager
                </Button>
              </div>
            )}
          </TabsContent>
        </Tabs>

        {/* Back button */}
        <div className="p-3 border-t border-border">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setSearched(false); setResults([]); setUnmatchedContacts([]); setSelectedInvites(new Set()); }}
            className="w-full text-xs text-muted-foreground"
          >
            ← Importer d'autres contacts
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col p-4 gap-4">
      {/* Contact Picker button (Android Chrome) */}
      {pickerSupported && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Users className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold text-sm">Depuis vos contacts</h3>
              <p className="text-xs text-muted-foreground">Sélectionnez des contacts pour les retrouver sur Forsure</p>
            </div>
          </div>
          <Button onClick={handlePickContacts} disabled={searching} className="gap-2 w-full">
            {searching ? (
              <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
            ) : (
              <Phone className="w-4 h-4" />
            )}
            {searching ? 'Recherche...' : 'Accéder à mes contacts'}
          </Button>
        </div>
      )}

      {/* vCard import */}
      <div className="flex flex-col gap-3">
        {pickerSupported && (
          <div className="relative flex items-center gap-2 py-1">
            <div className="flex-1 border-t border-border" />
            <span className="text-xs text-muted-foreground">ou</span>
            <div className="flex-1 border-t border-border" />
          </div>
        )}
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Upload className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-sm">Importer vos contacts</h3>
            <p className="text-xs text-muted-foreground">
              {isIOS
                ? 'Depuis Contacts → sélectionnez → Partager → fichier .vcf'
                : 'Importez un fichier vCard (.vcf) depuis votre répertoire'}
            </p>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".vcf,text/vcard,text/x-vcard"
          onChange={handleVCardImport}
          className="hidden"
        />
        <Button
          onClick={() => fileInputRef.current?.click()}
          disabled={searching}
          variant="outline"
          className="gap-2 w-full"
        >
          {searching ? (
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          ) : (
            <FileText className="w-4 h-4" />
          )}
          {searching ? 'Analyse en cours...' : 'Choisir un fichier .vcf'}
        </Button>
        {isIOS && (
          <div className="bg-muted/50 rounded-lg p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">Comment faire sur iPhone :</p>
            <ol className="list-decimal list-inside space-y-0.5">
              <li>Ouvrez l'app <strong>Contacts</strong></li>
              <li>Sélectionnez les contacts à partager</li>
              <li>Appuyez sur <strong>Partager</strong></li>
              <li>Choisissez <strong>Enregistrer dans Fichiers</strong></li>
              <li>Revenez ici et importez le fichier .vcf</li>
            </ol>
          </div>
        )}
      </div>

      {/* Separator */}
      <div className="relative flex items-center gap-2 py-1">
        <div className="flex-1 border-t border-border" />
        <span className="text-xs text-muted-foreground">ou</span>
        <div className="flex-1 border-t border-border" />
      </div>

      {/* Manual phone search */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Search className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-sm">Chercher par numéro</h3>
            <p className="text-xs text-muted-foreground">Entrez un ou plusieurs numéros de téléphone</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Input
            placeholder="06 12 34 56 78"
            value={phoneInput}
            onChange={e => setPhoneInput(e.target.value)}
            className="flex-1"
            type="tel"
          />
          <Button onClick={handleManualSearch} disabled={searching || !phoneInput.trim()} size="sm" className="gap-1.5">
            {searching ? (
              <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
            Chercher
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Séparez plusieurs numéros par des virgules
        </p>
      </div>
    </div>
  );
}

export function InviteContacts() {
  const navigate = useNavigate();
  const { isNative, loading, synced, matched, unmatched, syncContacts } = useContactSync();
  const sendRequest = useSendFriendRequest();
  const [search, setSearch] = useState('');
  const [selectedInvites, setSelectedInvites] = useState<Set<string>>(new Set());
  const [sentRequests, setSentRequests] = useState<Set<string>>(new Set());

  const handleAddFriend = async (userId: string) => {
    try {
      await sendRequest.mutateAsync(userId);
      setSentRequests(prev => new Set(prev).add(userId));
      toast({ title: '🤝 Demande envoyée !' });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const toggleInvite = (id: string) => {
    setSelectedInvites(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sendInvites = async () => {
    if (selectedInvites.size === 0) return;
    try {
      await Share.share({
        title: 'Rejoins Forsure !',
        text: INVITE_MESSAGE,
        dialogTitle: 'Inviter des amis',
      });
      toast({
        title: `${selectedInvites.size} invitation(s) envoyée(s) !`,
        description: 'Vos amis recevront le lien',
      });
      setSelectedInvites(new Set());
    } catch {
      // User cancelled
    }
  };

  const filteredMatched = matched.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.contact_name.toLowerCase().includes(search.toLowerCase())
  );

  const filteredUnmatched = unmatched.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.phone.includes(search)
  );

  // Web fallback — show phone search + share
  if (!isNative) {
    return <WebPhoneSearch />;
  }

  // Not synced yet
  if (!synced) {
    return (
      <div className="flex flex-col items-center justify-center p-8 gap-4 text-center">
        <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
          <Phone className="w-8 h-8 text-primary" />
        </div>
        <h3 className="font-semibold text-lg">Retrouvez vos amis</h3>
        <p className="text-sm text-muted-foreground max-w-xs">
          Synchronisez votre répertoire pour découvrir quels contacts sont déjà sur Forsure
        </p>
        <Button onClick={syncContacts} disabled={loading} className="gap-2">
          {loading ? (
            <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
          ) : (
            <Users className="w-4 h-4" />
          )}
          {loading ? 'Synchronisation...' : 'Synchroniser mes contacts'}
        </Button>
        <p className="text-xs text-muted-foreground/60 mt-1">
          🔒 Vos contacts ne sont pas stockés sur nos serveurs
        </p>
      </div>
    );
  }

  // Synced — show results
  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="p-3 border-b border-border">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Rechercher..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <Tabs defaultValue="found" className="flex-1 flex flex-col">
        <TabsList className="grid grid-cols-2 mx-3 mt-2">
          <TabsTrigger value="found" className="text-xs">
            Sur Forsure ({matched.length})
          </TabsTrigger>
          <TabsTrigger value="invite" className="text-xs">
            À inviter ({unmatched.length})
          </TabsTrigger>
        </TabsList>

        {/* Matched contacts */}
        <TabsContent value="found" className="flex-1 mt-0">
          <ScrollArea className="h-[350px]">
            <div className="divide-y divide-border">
              {filteredMatched.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  Aucun contact trouvé sur Forsure
                </p>
              ) : (
                filteredMatched.map(contact => (
                  <MatchedContactRow
                    key={contact.user_id}
                    contact={contact}
                    onAddFriend={handleAddFriend}
                    onViewProfile={() => navigate(`/profile/${contact.user_id}`)}
                    isSent={sentRequests.has(contact.user_id)}
                    isPending={sendRequest.isPending}
                  />
                ))
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Unmatched contacts to invite */}
        <TabsContent value="invite" className="flex-1 mt-0">
          <ScrollArea className="h-[350px]">
            <div className="px-3 py-2 flex justify-between items-center">
              <button
                onClick={() => {
                  if (selectedInvites.size === filteredUnmatched.length) {
                    setSelectedInvites(new Set());
                  } else {
                    setSelectedInvites(new Set(filteredUnmatched.map(c => c.id)));
                  }
                }}
                className="text-xs text-primary font-medium"
              >
                {selectedInvites.size === filteredUnmatched.length && filteredUnmatched.length > 0
                  ? 'Tout désélectionner'
                  : 'Tout sélectionner'}
              </button>
              <span className="text-xs text-muted-foreground">
                {selectedInvites.size} sélectionné{selectedInvites.size > 1 ? 's' : ''}
              </span>
            </div>
            <div className="divide-y divide-border">
              {filteredUnmatched.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  Tous vos contacts sont sur Forsure !
                </p>
              ) : (
                filteredUnmatched.map(contact => (
                  <button
                    key={contact.id}
                    onClick={() => toggleInvite(contact.id)}
                    className="w-full flex items-center gap-3 p-3 hover:bg-muted/50 transition-colors"
                  >
                    <Checkbox checked={selectedInvites.has(contact.id)} />
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-semibold text-muted-foreground">
                      {contact.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="text-left flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{contact.name}</p>
                      <p className="text-xs text-muted-foreground">{contact.phone}</p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </ScrollArea>

          {selectedInvites.size > 0 && (
            <div className="p-3 border-t border-border">
              <Button onClick={sendInvites} className="w-full gap-2">
                <Send className="w-4 h-4" />
                Inviter {selectedInvites.size} personne{selectedInvites.size > 1 ? 's' : ''}
              </Button>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function MatchedContactRow({
  contact,
  onAddFriend,
  onViewProfile,
  isSent,
  isPending,
}: {
  contact: MatchedContact;
  onAddFriend: (userId: string) => void;
  onViewProfile: () => void;
  isSent: boolean;
  isPending: boolean;
}) {
  return (
    <div className="flex items-center gap-3 p-3">
      <button onClick={onViewProfile} className="shrink-0">
        <UserAvatar src={contact.avatar_url} alt={contact.name} size="md" />
      </button>
      <div className="flex-1 min-w-0">
        <button onClick={onViewProfile} className="text-left">
          <p className="text-sm font-medium truncate">{contact.name}</p>
          <p className="text-xs text-muted-foreground truncate">
            {contact.contact_name !== contact.name ? `${contact.contact_name} dans vos contacts` : 'Dans vos contacts'}
          </p>
        </button>
      </div>
      {contact.is_friend ? (
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Check className="w-3.5 h-3.5 text-primary" /> Ami
        </span>
      ) : isSent ? (
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Check className="w-3.5 h-3.5" /> Envoyé
        </span>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onAddFriend(contact.user_id)}
          disabled={isPending}
          className="gap-1 text-xs"
        >
          <UserPlus className="w-3.5 h-3.5" />
          Ajouter
        </Button>
      )}
    </div>
  );
}
