import { useState, useRef } from 'react';
import { Share } from '@capacitor/share';
import { UserPlus, Search, Check, Send, Phone, Users, FileText, MessageCircle, Copy, RefreshCw, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/hooks/use-toast';
import { ScrollArea } from '@/components/ui/scroll-area';
import { UserAvatar } from '@/components/UserAvatar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useContactSync, MatchedContact } from '@/hooks/useContactSync';
import { useOAuthContactsImport } from '@/hooks/useOAuthContactsImport';
import { useSendFriendRequest } from '@/hooks/useFriendships';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { Badge } from '@/components/ui/badge';

const INVITE_MESSAGE = `Rejoins-moi sur Forsure, le réseau social de confiance ! 🚀\nTélécharge l'app ici : https://forsure.fans`;
const INVITE_LINK = 'https://forsure.fans';

// ─── Helpers ────────────────────────────────────────────────

function normalizePhone(phone: string): string {
  let clean = phone.replace(/[\s\-().]/g, '');
  if (clean.startsWith('0') && clean.length === 10) clean = '+33' + clean.slice(1);
  if (!clean.startsWith('+')) clean = '+' + clean;
  return clean;
}

interface VCardContact { name: string; phone: string; }

function parseVCardContacts(vcfContent: string): VCardContact[] {
  const contacts: VCardContact[] = [];
  const seen = new Set<string>();
  for (const entry of vcfContent.split(/(?=BEGIN:VCARD)/i)) {
    if (!entry.trim()) continue;
    const fnMatch = entry.match(/^FN[^:]*:(.+)$/im);
    const nMatch = entry.match(/^N[^:]*:([^;]*);([^;]*)/im);
    let name = fnMatch ? fnMatch[1].trim() : nMatch ? `${nMatch[2]?.trim() || ''} ${nMatch[1]?.trim() || ''}`.trim() : '';
    const telRegex = /^(?:item\d+\.)?TEL[^:]*:(.+)$/gim;
    let telMatch;
    while ((telMatch = telRegex.exec(entry)) !== null) {
      const raw = telMatch[1].trim().replace(/[\s\-().]/g, '');
      if (raw.length >= 6) {
        const normalized = normalizePhone(raw);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          contacts.push({ name: name || normalized, phone: normalized });
        }
      }
    }
  }
  return contacts;
}

function hasContactPicker(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return false;
  return 'contacts' in navigator && 'ContactsManager' in window;
}

function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// ─── Quick Share Buttons ────────────────────────────────────

function QuickShareBar() {
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(INVITE_LINK);
      toast({ title: '🔗 Lien copié !', description: 'Collez-le où vous voulez' });
    } catch {
      const ta = document.createElement('textarea');
      ta.value = INVITE_LINK;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast({ title: '🔗 Lien copié !' });
    }
  };

  const shareWhatsApp = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(INVITE_MESSAGE)}`, '_blank');
  };

  const shareNative = async () => {
    try {
      await Share.share({ title: 'Rejoins Forsure !', text: INVITE_MESSAGE, dialogTitle: 'Inviter des amis' });
    } catch {
      copyLink();
    }
  };

  return (
    <div className="flex gap-2">
      <Button onClick={shareWhatsApp} size="sm" className="flex-1 gap-1.5 bg-[#25D366] hover:bg-[#1da851] text-white text-xs h-9">
        <MessageCircle className="w-3.5 h-3.5" />
        WhatsApp
      </Button>
      <Button onClick={shareNative} size="sm" variant="outline" className="flex-1 gap-1.5 text-xs h-9">
        <Send className="w-3.5 h-3.5" />
        Partager
      </Button>
      <Button onClick={() => {
        navigator.clipboard.writeText(INVITE_LINK).catch(() => {});
        toast({ title: '🔗 Lien copié !' });
      }} size="sm" variant="outline" className="gap-1.5 text-xs h-9 px-3">
        <Copy className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}

// ─── Matched Contact Row ────────────────────────────────────

function MatchedContactRow({ contact, onAdd, onView, isSent, isPending }: {
  contact: MatchedContact; onAdd: (id: string) => void; onView: () => void; isSent: boolean; isPending: boolean;
}) {
  return (
    <div className="flex items-center gap-3 p-3">
      <button onClick={onView} className="shrink-0">
        <UserAvatar src={contact.avatar_url} alt={contact.name} size="md" />
      </button>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{contact.name}</p>
        <p className="text-xs text-muted-foreground truncate">
          {contact.contact_name !== contact.name ? `${contact.contact_name} dans tes contacts` : 'Dans tes contacts'}
        </p>
      </div>
      {contact.is_friend ? (
        <span className="text-xs text-muted-foreground flex items-center gap-1"><Check className="w-3.5 h-3.5 text-primary" /> Ami</span>
      ) : isSent ? (
        <span className="text-xs text-muted-foreground flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Envoyé</span>
      ) : (
        <Button size="sm" variant="outline" onClick={() => onAdd(contact.user_id)} disabled={isPending} className="gap-1 text-xs">
          <UserPlus className="w-3.5 h-3.5" /> Ajouter
        </Button>
      )}
    </div>
  );
}

// ─── Results View (shared between web & native) ─────────────

function ResultsView({ matched, unmatched, onBack }: {
  matched: MatchedContact[];
  unmatched: VCardContact[];
  onBack?: () => void;
}) {
  const navigate = useNavigate();
  const sendRequest = useSendFriendRequest();
  const [sentRequests, setSentRequests] = useState<Set<string>>(new Set());
  const [selectedInvites, setSelectedInvites] = useState<Set<string>>(new Set());

  const handleAdd = async (userId: string) => {
    try {
      await sendRequest.mutateAsync(userId);
      setSentRequests(prev => new Set(prev).add(userId));
      toast({ title: '🤝 Demande envoyée !' });
    } catch { toast({ title: 'Erreur', variant: 'destructive' }); }
  };

  const toggleInvite = (phone: string) => {
    setSelectedInvites(prev => {
      const next = new Set(prev);
      next.has(phone) ? next.delete(phone) : next.add(phone);
      return next;
    });
  };

  const inviteSMS = () => {
    const phones = Array.from(selectedInvites);
    if (phones.length === 1) {
      const sep = /iPhone|iPad|iPod|Mac/i.test(navigator.userAgent) ? '&' : '?';
      window.open(`sms:${phones[0]}${sep}body=${encodeURIComponent(INVITE_MESSAGE)}`, '_self');
    } else {
      const text = `${INVITE_MESSAGE}\n\n📋 Numéros (${phones.length}) :\n${phones.join('\n')}`;
      navigator.clipboard.writeText(text).catch(() => {});
      toast({ title: `✅ ${phones.length} numéros copiés`, description: 'Collez dans votre app SMS' });
    }
  };

  const inviteWhatsApp = () => {
    const phones = Array.from(selectedInvites);
    const encoded = encodeURIComponent(INVITE_MESSAGE);
    if (phones.length === 1) {
      window.open(`https://wa.me/${phones[0].replace('+', '')}?text=${encoded}`, '_blank');
    } else {
      window.open(`https://wa.me/?text=${encoded}`, '_blank');
    }
  };

  return (
    <div className="flex flex-col h-full">
      <Tabs defaultValue={matched.length > 0 ? 'found' : 'invite'} className="flex-1 flex flex-col">
        <TabsList className="grid grid-cols-2 mx-3 mt-2">
          <TabsTrigger value="found" className="text-xs">Sur Forsure ({matched.length})</TabsTrigger>
          <TabsTrigger value="invite" className="text-xs">À inviter ({unmatched.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="found" className="flex-1 mt-0">
          <ScrollArea className="h-[380px]">
            <div className="divide-y divide-border">
              {matched.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">Aucun contact trouvé sur Forsure</p>
              ) : matched.map(c => (
                <MatchedContactRow key={c.user_id} contact={c} onAdd={handleAdd}
                  onView={() => navigate(`/profile/${c.user_id}`)} isSent={sentRequests.has(c.user_id)} isPending={sendRequest.isPending} />
              ))}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="invite" className="flex-1 mt-0">
          <ScrollArea className="h-[320px]">
            <div className="px-3 py-2 flex justify-between items-center">
              <button onClick={() => {
                selectedInvites.size === unmatched.length ? setSelectedInvites(new Set()) : setSelectedInvites(new Set(unmatched.map(c => c.phone)));
              }} className="text-xs text-primary font-medium">
                {selectedInvites.size === unmatched.length && unmatched.length > 0 ? 'Tout désélectionner' : 'Tout sélectionner'}
              </button>
              <span className="text-xs text-muted-foreground">{selectedInvites.size} sélectionné{selectedInvites.size > 1 ? 's' : ''}</span>
            </div>
            <div className="divide-y divide-border">
              {unmatched.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">Tous tes contacts sont sur Forsure ! 🎉</p>
              ) : unmatched.map(c => (
                <button key={c.phone} onClick={() => toggleInvite(c.phone)} className="w-full flex items-center gap-3 p-3 hover:bg-muted/50 transition-colors">
                  <Checkbox checked={selectedInvites.has(c.phone)} />
                  <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center text-sm font-semibold text-muted-foreground">
                    {c.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="text-left flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{c.name}</p>
                    <p className="text-xs text-muted-foreground">{c.phone}</p>
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>

          <div className="p-3 border-t border-border flex gap-2">
            <Button onClick={inviteWhatsApp} className="flex-1 gap-1.5 bg-[#25D366] hover:bg-[#1da851] text-white text-xs h-9">
              <MessageCircle className="w-3.5 h-3.5" />
              WhatsApp{selectedInvites.size > 0 ? ` (${selectedInvites.size})` : ''}
            </Button>
            {selectedInvites.size > 0 && (
              <Button onClick={inviteSMS} variant="outline" className="flex-1 gap-1.5 text-xs h-9">
                <Phone className="w-3.5 h-3.5" /> SMS
              </Button>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {onBack && (
        <div className="p-3 border-t border-border">
          <Button variant="ghost" size="sm" onClick={onBack} className="w-full text-xs text-muted-foreground">
            ← Importer d'autres contacts
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────

export function InviteContacts() {
  const { user } = useAuth();
  const contactSync = useContactSync();
  const oauthImport = useOAuthContactsImport();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [searching, setSearching] = useState(false);
  const [webMatched, setWebMatched] = useState<MatchedContact[]>([]);
  const [webUnmatched, setWebUnmatched] = useState<VCardContact[]>([]);
  const [hasResults, setHasResults] = useState(false);
  const [phoneInput, setPhoneInput] = useState('');

  const GOOGLE_CLIENT_ID = '124247938147-u2u3jptog9sf2i4ecrkujn4asdnmvsbd.apps.googleusercontent.com';

  const pickerSupported = hasContactPicker();
  const isIOS = isIOSDevice();

  // ── Search phones against DB ──
  const searchPhones = async (vcContacts: VCardContact[]) => {
    if (!user || vcContacts.length === 0) return;
    setSearching(true);
    try {
      const phones = vcContacts.map(c => c.phone).slice(0, 500);
      const { data: matches, error } = await supabase.rpc('match_contacts_by_phone', {
        p_phone_numbers: phones,
      });
      if (error) throw error;
      const matchedResults: MatchedContact[] = (matches || []).map((m: any) => ({
        user_id: m.user_id, name: m.name, avatar_url: m.avatar_url,
        phone_number: m.phone_number, is_friend: m.is_friend, contact_name: m.name,
      }));
      const matchedPhones = new Set((matches || []).map((m: any) => m.phone_number));
      setWebMatched(matchedResults);
      setWebUnmatched(vcContacts.filter(c => !matchedPhones.has(c.phone)));
      setHasResults(true);
      toast({ title: matchedResults.length > 0
        ? `${matchedResults.length} contact(s) trouvé(s) sur Forsure !`
        : `${vcContacts.length - matchedResults.length} contact(s) à inviter`
      });
    } catch { toast({ title: 'Erreur', variant: 'destructive' }); }
    finally { setSearching(false); }
  };

  const handlePickContacts = async () => {
    try {
      const contacts = await (navigator as any).contacts.select(['tel', 'name'], { multiple: true });
      const vcContacts: VCardContact[] = [];
      for (const c of contacts) {
        for (const tel of (c.tel || [])) {
          const clean = tel.replace(/[\s\-().]/g, '');
          if (clean.length >= 6) vcContacts.push({ name: c.name?.[0] || clean, phone: normalizePhone(clean) });
        }
      }
      if (vcContacts.length === 0) { toast({ title: 'Aucun numéro trouvé' }); return; }
      await searchPhones(vcContacts);
    } catch { /* user cancelled */ }
  };

  const handleVCardImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const vcContacts = parseVCardContacts(await file.text());
      if (vcContacts.length === 0) { toast({ title: 'Aucun numéro trouvé dans le fichier' }); return; }
      toast({ title: `${vcContacts.length} contact(s) détecté(s)` });
      await searchPhones(vcContacts);
    } catch { toast({ title: 'Erreur de lecture', variant: 'destructive' }); }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleManualSearch = async () => {
    if (!phoneInput.trim()) return;
    const vcContacts = phoneInput.split(/[,\n;]+/).map(n => n.trim()).filter(n => n.length >= 6)
      .map(p => ({ name: p, phone: normalizePhone(p) }));
    await searchPhones(vcContacts);
  };

  // ── Native: use Capacitor contacts ──
  if (contactSync.isNative) {
    if (!contactSync.synced) {
      return (
        <div className="flex flex-col items-center justify-center p-8 gap-4 text-center">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
            <Phone className="w-8 h-8 text-primary" />
          </div>
          <h3 className="font-semibold text-lg">Retrouve tes amis</h3>
          <p className="text-sm text-muted-foreground max-w-xs">
            {contactSync.platform === 'ios'
              ? 'Synchronise ton répertoire iPhone pour voir qui est déjà sur Forsure'
              : 'Synchronise ton répertoire Android pour voir qui est déjà sur Forsure'}
          </p>
          <Badge variant="secondary" className="text-xs">
            {contactSync.platform === 'ios' ? '🍎 iPhone' : '🤖 Android'}
          </Badge>
          <Button onClick={contactSync.syncContacts} disabled={contactSync.loading} className="gap-2" size="lg">
            {contactSync.loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Phone className="w-4 h-4" />}
            {contactSync.loading ? 'Synchronisation...' : 'Synchroniser mes contacts'}
          </Button>
          <p className="text-xs text-muted-foreground/60">🔒 Tes contacts ne sont pas stockés sur nos serveurs</p>
          <div className="w-full pt-2"><QuickShareBar /></div>
        </div>
      );
    }
    const unmatchedVCard = contactSync.unmatched.map(c => ({ name: c.name, phone: c.phone }));
    return <ResultsView matched={contactSync.matched} unmatched={unmatchedVCard} />;
  }

  // ── Web: show results if we have them ──
  if (hasResults) {
    return <ResultsView matched={webMatched} unmatched={webUnmatched} onBack={() => { setHasResults(false); setWebMatched([]); setWebUnmatched([]); }} />;
  }

  // ── OAuth results ──
  if (oauthImport.imported && oauthImport.matches.length > 0) {
    const oauthMatched: MatchedContact[] = oauthImport.matches;
    return <ResultsView matched={oauthMatched} unmatched={[]} onBack={() => window.location.reload()} />;
  }

  // ── Web: unified import screen ──
  return (
    <div className="flex flex-col p-4 gap-5">
      {/* Header */}
      <div className="text-center pb-1">
        <h3 className="font-semibold text-base">Invite tes amis sur Forsure</h3>
        <p className="text-xs text-muted-foreground mt-1">Partage le lien ou retrouve tes contacts</p>
      </div>

      {/* Quick share */}
      <QuickShareBar />

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 border-t border-border" />
        <span className="text-xs text-muted-foreground font-medium">Retrouver tes contacts</span>
        <div className="flex-1 border-t border-border" />
      </div>

      {/* Import methods */}
      <div className="space-y-2.5">
        {/* Google import */}
        <Button
          onClick={() => oauthImport.importGoogleContacts(GOOGLE_CLIENT_ID)}
          disabled={oauthImport.loading || !GOOGLE_CLIENT_ID}
          variant="outline"
          className="gap-2 w-full h-12 justify-start"
        >
          <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0">
            <svg className="w-4 h-4" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
          </div>
          <div className="text-left">
            <p className="text-sm font-medium">Contacts Google</p>
            <p className="text-[10px] text-muted-foreground">Gmail, Android...</p>
          </div>
        </Button>


        {/* Contact Picker (Android Chrome) */}
        {pickerSupported && (
          <Button onClick={handlePickContacts} disabled={searching} variant="outline" className="gap-2 w-full h-12 justify-start">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <Users className="w-4 h-4 text-primary" />
            </div>
            <div className="text-left">
              <p className="text-sm font-medium">Depuis mes contacts</p>
              <p className="text-[10px] text-muted-foreground">Sélectionne directement dans ton répertoire</p>
            </div>
          </Button>
        )}

        {/* VCF import */}
        <input ref={fileInputRef} type="file" accept=".vcf,text/vcard,text/x-vcard" onChange={handleVCardImport} className="hidden" />
        <Button onClick={() => fileInputRef.current?.click()} disabled={searching} variant="outline" className="gap-2 w-full h-12 justify-start">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <FileText className="w-4 h-4 text-primary" />
          </div>
          <div className="text-left">
            <p className="text-sm font-medium">Importer un fichier .vcf</p>
            <p className="text-[10px] text-muted-foreground">
              {isIOS ? 'Contacts → Sélectionner → Partager → Fichier' : 'Exporte ton répertoire en fichier vCard'}
            </p>
          </div>
        </Button>

        {/* Manual search */}
        <div className="flex gap-2">
          <Input placeholder="06 12 34 56 78" value={phoneInput} onChange={e => setPhoneInput(e.target.value)} type="tel" className="flex-1 h-10" />
          <Button onClick={handleManualSearch} disabled={searching || !phoneInput.trim()} size="sm" className="gap-1.5 h-10 px-4">
            <Search className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Loading */}
      {(searching || oauthImport.loading) && (
        <div className="flex items-center justify-center gap-2 py-4">
          <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-muted-foreground">Analyse en cours...</span>
        </div>
      )}

      {/* iOS instructions */}
      {isIOS && (
        <div className="bg-muted/50 rounded-xl p-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">💡 Comment faire sur iPhone :</p>
          <ol className="list-decimal list-inside space-y-0.5">
            <li>Ouvre l'app <strong>Contacts</strong></li>
            <li>Sélectionne les contacts à partager</li>
            <li>Appuie sur <strong>Partager</strong> → <strong>Fichiers</strong></li>
            <li>Reviens ici et importe le fichier .vcf</li>
          </ol>
        </div>
      )}

      <p className="text-xs text-muted-foreground/60 text-center">
        🔒 Tes contacts ne sont pas stockés sur nos serveurs
      </p>
    </div>
  );
}
