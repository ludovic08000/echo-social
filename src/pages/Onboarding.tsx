import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Check, Zap, ArrowRight, Users, Phone, Upload, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import BrandLogo from '@/components/BrandLogo';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { motion, AnimatePresence } from 'framer-motion';
import { Capacitor } from '@capacitor/core';
import { useSendFriendRequest } from '@/hooks/useFriendships';
import { UserAvatar } from '@/components/UserAvatar';
import { MatchedContact } from '@/hooks/useContactSync';
import { ScrollArea } from '@/components/ui/scroll-area';

const INTERESTS = [
  { value: 'gaming', label: 'Gaming', emoji: '🎮', color: 'border-purple-500/40 bg-purple-500/10 text-purple-300' },
  { value: 'music', label: 'Musique', emoji: '🎵', color: 'border-pink-500/40 bg-pink-500/10 text-pink-300' },
  { value: 'sport', label: 'Sport', emoji: '⚽', color: 'border-green-500/40 bg-green-500/10 text-green-300' },
  { value: 'news', label: 'Actualités', emoji: '📰', color: 'border-blue-500/40 bg-blue-500/10 text-blue-300' },
  { value: 'education', label: 'Éducation', emoji: '📚', color: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300' },
  { value: 'cooking', label: 'Cuisine', emoji: '🍳', color: 'border-orange-500/40 bg-orange-500/10 text-orange-300' },
  { value: 'tech', label: 'Tech', emoji: '💻', color: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300' },
  { value: 'art', label: 'Art & Créativité', emoji: '🎨', color: 'border-rose-500/40 bg-rose-500/10 text-rose-300' },
  { value: 'lifestyle', label: 'Lifestyle', emoji: '✨', color: 'border-amber-500/40 bg-amber-500/10 text-amber-300' },
  { value: 'comedy', label: 'Humour', emoji: '😂', color: 'border-lime-500/40 bg-lime-500/10 text-lime-300' },
  { value: 'travel', label: 'Voyage', emoji: '✈️', color: 'border-sky-500/40 bg-sky-500/10 text-sky-300' },
];

const MIN_INTERESTS = 3;

const AI_NAME_SUGGESTIONS = ['Zeus', 'Nova', 'Atlas', 'Luna', 'Aria', 'Echo', 'Orion', 'Pixel'];

export default function Onboarding() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [step, setStep] = useState<'interests' | 'ai-name' | 'find-friends'>('interests');
  const [selected, setSelected] = useState<string[]>([]);
  const [aiName, setAiName] = useState('Zeus');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Find friends state
  const sendRequest = useSendFriendRequest();
  const [sentRequests, setSentRequests] = useState<Set<string>>(new Set());
  const [contactResults, setContactResults] = useState<MatchedContact[]>([]);
  const [searchingContacts, setSearchingContacts] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isNative = Capacitor.isNativePlatform();
  const isIOS = typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  const hasPickerAPI = typeof navigator !== 'undefined' && !isIOS && 'contacts' in navigator && 'ContactsManager' in window;

  function normalizePhone(phone: string): string {
    let clean = phone.replace(/[\s\-().]/g, '');
    if (clean.startsWith('0') && clean.length === 10) clean = '+33' + clean.slice(1);
    if (!clean.startsWith('+')) clean = '+' + clean;
    return clean;
  }

  const searchPhones = async (phones: string[]) => {
    if (!user || phones.length === 0) return;
    setSearchingContacts(true);
    try {
      const normalized = phones.map(normalizePhone);
      const { data, error } = await supabase.rpc('match_contacts_by_phone', {
        p_user_id: user.id,
        p_phone_numbers: normalized,
      });
      if (error) throw error;
      const results: MatchedContact[] = (data || []).map((m: any) => ({
        user_id: m.user_id, name: m.name, avatar_url: m.avatar_url,
        phone_number: m.phone_number, is_friend: m.is_friend, contact_name: m.name,
      }));
      setContactResults(results);
      if (results.length === 0) toast({ title: 'Aucun contact trouvé sur Forsure' });
      else toast({ title: `${results.length} contact(s) trouvé(s) !` });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    } finally {
      setSearchingContacts(false);
    }
  };

  const handlePickContacts = async () => {
    try {
      const contacts = await (navigator as any).contacts.select(['tel'], { multiple: true });
      const phones: string[] = [];
      for (const c of contacts) {
        for (const tel of (c.tel || [])) {
          const clean = tel.replace(/[\s\-().]/g, '');
          if (clean.length >= 6) phones.push(clean);
        }
      }
      if (phones.length > 0) await searchPhones(phones);
    } catch {}
  };

  const handleNativeContacts = async () => {
    try {
      const { Contacts } = await import('@capacitor-community/contacts');
      const perm = await Contacts.requestPermissions();
      if (perm.contacts !== 'granted') {
        toast({ title: 'Accès refusé', description: 'Autorisez l\'accès aux contacts dans les réglages', variant: 'destructive' });
        return;
      }
      const result = await Contacts.getContacts({ projection: { phones: true, name: true } });
      const phones: string[] = [];
      (result.contacts || []).forEach((c: any) => {
        (c.phones || []).forEach((p: any) => {
          if (p.number) phones.push(p.number);
        });
      });
      if (phones.length > 0) await searchPhones(phones);
      else toast({ title: 'Aucun numéro trouvé dans vos contacts' });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const handleVCardImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const telRegex = /^TEL[^:]*:(.+)$/gim;
      const phones: string[] = [];
      let match;
      while ((match = telRegex.exec(text)) !== null) {
        const raw = match[1].trim().replace(/[\s\-().]/g, '');
        if (raw.length >= 6) phones.push(normalizePhone(raw));
      }
      if (phones.length > 0) await searchPhones(phones);
      else toast({ title: 'Aucun numéro trouvé dans le fichier' });
    } catch {
      toast({ title: 'Erreur de lecture', variant: 'destructive' });
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
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

  const toggle = (value: string) => {
    setSelected(prev =>
      prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]
    );
  };

  const handleInterestsDone = () => {
    if (selected.length < MIN_INTERESTS) {
      toast({ title: `Choisis au moins ${MIN_INTERESTS} centres d'intérêt`, variant: 'destructive' });
      return;
    }
    setStep('ai-name');
  };

  const handleAiNameDone = () => {
    if (!aiName.trim()) {
      toast({ title: 'Donne un nom à ton IA !', variant: 'destructive' });
      return;
    }
    setStep('find-friends');
  };

  const handleFinish = async () => {
    if (!user) return;
    if (!aiName.trim()) {
      toast({ title: 'Donne un nom à ton IA !', variant: 'destructive' });
      return;
    }

    setIsSubmitting(true);
    try {
      // Save interests
      const rows = selected.map(interest => ({
        user_id: user.id,
        interest_type: 'category',
        interest_value: interest,
        explicit: true,
        weight: 1,
      }));
      const { error: interestsErr } = await supabase.from('user_interests').upsert(rows, { onConflict: 'user_id,interest_type,interest_value' } as any);
      if (interestsErr) throw interestsErr;

      // Save AI companion name
      const { error: zeusErr } = await supabase.from('zeus_user_settings').upsert(
        { user_id: user.id, custom_name: aiName.trim() },
        { onConflict: 'user_id' }
      );
      if (zeusErr) throw zeusErr;

      toast({ title: `Bienvenue sur ForSure ! 🎉`, description: `${aiName.trim()} est prêt à t'accompagner !` });
      navigate('/feed', { replace: true });
    } catch (err: any) {
      toast({ title: 'Erreur', description: err.message, variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-lg">
        <div className="flex items-center justify-center mb-6">
          <BrandLogo className="h-10 w-auto" />
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className={`w-2.5 h-2.5 rounded-full transition-colors ${step === 'interests' ? 'bg-primary' : 'bg-primary/30'}`} />
          <div className={`w-2.5 h-2.5 rounded-full transition-colors ${step === 'ai-name' ? 'bg-primary' : 'bg-primary/30'}`} />
          <div className={`w-2.5 h-2.5 rounded-full transition-colors ${step === 'find-friends' ? 'bg-primary' : 'bg-primary/30'}`} />
        </div>

        <AnimatePresence mode="wait">
          {step === 'interests' && (
            <motion.div
              key="interests"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="pulse-card p-6 sm:p-8"
            >
              <div className="text-center mb-6">
                <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-3 py-1 rounded-full text-sm font-medium mb-3">
                  <Sparkles className="w-4 h-4" />
                  Étape 1/3
                </div>
                <h1 className="text-2xl font-bold text-foreground">Qu'est-ce qui t'intéresse ?</h1>
                <p className="text-muted-foreground text-sm mt-1">
                  Choisis au moins {MIN_INTERESTS} sujets pour personnaliser ton fil
                </p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
                {INTERESTS.map((item) => {
                  const isSelected = selected.includes(item.value);
                  return (
                    <motion.button
                      key={item.value}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => toggle(item.value)}
                      className={`
                        relative flex flex-col items-center gap-1.5 p-4 rounded-xl border-2 transition-all duration-200
                        ${isSelected
                          ? 'border-primary bg-primary/10 shadow-lg shadow-primary/10'
                          : `${item.color} hover:border-primary/30`
                        }
                      `}
                    >
                      {isSelected && (
                        <motion.div
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          className="absolute top-1.5 right-1.5 bg-primary rounded-full p-0.5"
                        >
                          <Check className="w-3 h-3 text-primary-foreground" />
                        </motion.div>
                      )}
                      <span className="text-2xl">{item.emoji}</span>
                      <span className={`text-sm font-medium ${isSelected ? 'text-primary' : ''}`}>
                        {item.label}
                      </span>
                    </motion.button>
                  );
                })}
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  {selected.length}/{MIN_INTERESTS} minimum
                </span>
                <Button
                  onClick={handleInterestsDone}
                  disabled={selected.length < MIN_INTERESTS}
                  className="pulse-button-gradient px-6 gap-2"
                >
                  Suivant <ArrowRight className="w-4 h-4" />
                </Button>
              </div>
            </motion.div>
          )}

          {step === 'ai-name' && (
            <motion.div
              key="ai-name"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="pulse-card p-6 sm:p-8"
            >
              <div className="text-center mb-6">
                <div className="inline-flex items-center gap-2 bg-gradient-to-r from-amber-500/20 to-orange-500/20 text-amber-500 px-3 py-1 rounded-full text-sm font-medium mb-3">
                  <Zap className="w-4 h-4" />
                  Étape 2/3
                </div>
                <h1 className="text-2xl font-bold text-foreground">Nomme ton IA personnelle</h1>
                <p className="text-muted-foreground text-sm mt-1">
                  Ton compagnon IA t'accompagnera partout sur ForSure. Il veille sur toi, t'écoute et peut poster pour toi.
                </p>
              </div>

              {/* AI Avatar */}
              <div className="flex justify-center mb-6">
                <motion.div
                  animate={{ rotate: [0, 5, -5, 0] }}
                  transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                  className="w-24 h-24 rounded-3xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white shadow-xl shadow-amber-500/30"
                >
                  <Zap className="w-12 h-12" />
                </motion.div>
              </div>

              {/* Name input */}
              <div className="mb-4">
                <Input
                  value={aiName}
                  onChange={e => setAiName(e.target.value)}
                  placeholder="Donne un nom à ton IA..."
                  maxLength={20}
                  className="text-center text-lg font-semibold h-12 rounded-xl"
                  autoFocus
                />
              </div>

              {/* Suggestions */}
              <div className="flex flex-wrap gap-2 justify-center mb-6">
                {AI_NAME_SUGGESTIONS.map(name => (
                  <button
                    key={name}
                    onClick={() => setAiName(name)}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${
                      aiName === name
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border/40 bg-secondary/40 text-muted-foreground hover:border-primary/30'
                    }`}
                  >
                    {name}
                  </button>
                ))}
              </div>

              {/* Preview */}
              {aiName.trim() && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-4 rounded-xl bg-gradient-to-r from-amber-500/5 to-orange-500/5 border border-amber-500/20 mb-6"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white text-sm shrink-0">
                      ⚡
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">{aiName.trim()}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Salut ! Je suis <strong>{aiName.trim()}</strong>, ton compagnon IA. Je suis là pour toi ! 💬
                      </p>
                    </div>
                  </div>
                </motion.div>
              )}

              <div className="flex items-center justify-between">
                <Button
                  variant="ghost"
                  onClick={() => setStep('interests')}
                  className="text-muted-foreground"
                >
                  Retour
                </Button>
                <Button
                  onClick={handleAiNameDone}
                  disabled={!aiName.trim()}
                  className="pulse-button-gradient px-6 gap-2"
                >
                  Suivant <ArrowRight className="w-4 h-4" />
                </Button>
                </Button>
              </div>
            </motion.div>
          )}

          {step === 'find-friends' && (
            <motion.div
              key="find-friends"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="pulse-card p-6 sm:p-8"
            >
              <div className="text-center mb-6">
                <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-3 py-1 rounded-full text-sm font-medium mb-3">
                  <Users className="w-4 h-4" />
                  Étape 3/3
                </div>
                <h1 className="text-2xl font-bold text-foreground">Retrouve tes amis</h1>
                <p className="text-muted-foreground text-sm mt-1">
                  {isNative
                    ? 'Importe tes contacts pour retrouver tes amis déjà sur Forsure'
                    : isIOS
                      ? 'Exporte tes contacts en fichier .vcf puis importe-le ici'
                      : hasPickerAPI
                        ? 'Sélectionne des contacts pour les retrouver sur Forsure'
                        : 'Importe un fichier de contacts (.vcf) pour retrouver tes amis'}
                </p>
              </div>

              <div className="space-y-3 mb-4">
                {isNative && (
                  <Button onClick={handleNativeContacts} disabled={searchingContacts} className="gap-2 w-full">
                    {searchingContacts ? (
                      <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <Phone className="w-4 h-4" />
                    )}
                    {searchingContacts ? 'Recherche...' : 'Importer mes contacts'}
                  </Button>
                )}

                {!isNative && hasPickerAPI && (
                  <Button onClick={handlePickContacts} disabled={searchingContacts} className="gap-2 w-full">
                    {searchingContacts ? (
                      <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <Phone className="w-4 h-4" />
                    )}
                    {searchingContacts ? 'Recherche...' : 'Accéder à mes contacts'}
                  </Button>
                )}

                {!isNative && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".vcf,text/vcard,text/x-vcard"
                      onChange={handleVCardImport}
                      className="hidden"
                    />
                    <Button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={searchingContacts}
                      variant={hasPickerAPI ? 'outline' : 'default'}
                      className="gap-2 w-full"
                    >
                      <Upload className="w-4 h-4" />
                      {isIOS ? 'Importer depuis fichier .vcf' : 'Importer un fichier contacts (.vcf)'}
                    </Button>
                  </>
                )}

                {isIOS && !isNative && (
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

              {contactResults.length > 0 && (
                <ScrollArea className="max-h-48 mb-4">
                  <div className="space-y-2">
                    {contactResults.map(contact => (
                      <div key={contact.user_id} className="flex items-center justify-between p-2.5 rounded-xl bg-secondary/30">
                        <div className="flex items-center gap-2.5">
                          <UserAvatar name={contact.name} avatarUrl={contact.avatar_url} size="sm" />
                          <span className="text-sm font-medium">{contact.name}</span>
                        </div>
                        {contact.is_friend || sentRequests.has(contact.user_id) ? (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Check className="w-3.5 h-3.5" />
                            {contact.is_friend ? 'Ami' : 'Envoyé'}
                          </span>
                        ) : (
                          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => handleAddFriend(contact.user_id)}>
                            <Users className="w-3.5 h-3.5" /> Ajouter
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}

              <div className="flex items-center justify-between">
                <Button
                  variant="ghost"
                  onClick={() => setStep('ai-name')}
                  className="text-muted-foreground"
                >
                  Retour
                </Button>
                <Button
                  onClick={handleFinish}
                  disabled={isSubmitting}
                  className="pulse-button-gradient px-8"
                >
                  {isSubmitting ? 'Enregistrement…' : 'C\'est parti ! 🚀'}
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
