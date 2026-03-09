import { useState } from 'react';
import { Shield, Upload, Lock, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import BrandLogo from '@/components/BrandLogo';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { uploadToR2 } from '@/lib/r2';
import { toast } from '@/hooks/use-toast';
import { motion } from 'framer-motion';

/**
 * Blocking screen shown when the AI age verification flags a user.
 * Requires:
 * 1. A parent to set a parental PIN (8+ digits)
 * 2. Upload of an ID document
 * The user cannot access the app until both steps are done.
 */
export function AgeFlaggedScreen() {
  const { user, signOut } = useAuth();
  const [step, setStep] = useState<'pin' | 'id'>('pin');
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [isSubmittingPin, setIsSubmittingPin] = useState(false);
  const [isUploadingId, setIsUploadingId] = useState(false);
  const [idUploaded, setIdUploaded] = useState(false);

  const handlePinSubmit = async () => {
    if (pin.length < 8 || !/^\d{8,12}$/.test(pin)) {
      toast({ title: 'Code invalide', description: 'Le code parental doit contenir au moins 8 chiffres.', variant: 'destructive' });
      return;
    }
    if (pin !== pinConfirm) {
      toast({ title: 'Les codes ne correspondent pas', variant: 'destructive' });
      return;
    }

    setIsSubmittingPin(true);
    try {
      const { error } = await supabase.functions.invoke('verify-parental-pin', {
        body: {
          action: 'set',
          pin,
          allowed_categories: ['education', 'sport', 'gaming', 'musique', 'art', 'humour'],
        },
      });
      if (error) throw error;

      toast({ title: 'Code parental défini ✓' });
      setStep('id');
    } catch (err: any) {
      toast({ title: 'Erreur', description: err.message, variant: 'destructive' });
    } finally {
      setIsSubmittingPin(false);
    }
  };

  const handleIdUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    if (file.size > 10 * 1024 * 1024) {
      toast({ title: 'Fichier trop volumineux', description: 'Maximum 10 Mo.', variant: 'destructive' });
      return;
    }

    setIsUploadingId(true);
    try {
      const { url } = await uploadToR2(file, 'documents');

      // Update the identity verification record with the document
      const { error } = await supabase
        .from('identity_verifications')
        .update({ id_document_url: url, status: 'pending' })
        .eq('reported_user_id', user.id)
        .eq('status', 'pending');

      if (error) throw error;

      // Update profile status to pending
      await supabase
        .from('profiles')
        .update({ age_verification_status: 'pending' })
        .eq('user_id', user.id);

      setIdUploaded(true);
      toast({ title: 'Pièce d\'identité envoyée ✓', description: 'Votre compte sera vérifié dans les 72h.' });
    } catch (err: any) {
      toast({ title: 'Erreur d\'upload', description: err.message, variant: 'destructive' });
    } finally {
      setIsUploadingId(false);
    }
  };

  if (idUploaded) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="w-full max-w-md text-center">
          <BrandLogo className="h-10 w-auto mx-auto mb-6" />
          <div className="pulse-card p-8">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
              <Shield className="w-8 h-8 text-primary" />
            </div>
            <h1 className="text-xl font-bold text-foreground mb-2">Vérification en cours</h1>
            <p className="text-muted-foreground text-sm mb-6">
              Votre pièce d'identité a été envoyée. Notre équipe vérifiera votre compte dans les <strong>72 heures</strong>.
              Vous recevrez une notification une fois la vérification terminée.
            </p>
            <p className="text-xs text-muted-foreground mb-6">
              En attendant, votre compte reste en mode protégé avec le contrôle parental activé.
            </p>
            <Button variant="outline" onClick={() => signOut()} className="w-full">
              Se déconnecter
            </Button>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md">
        <BrandLogo className="h-10 w-auto mx-auto mb-6" />

        <div className="pulse-card p-6 sm:p-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5 text-destructive" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-foreground">Vérification d'âge requise</h1>
              <p className="text-xs text-muted-foreground">Notre système a détecté une incohérence</p>
            </div>
          </div>

          <div className="bg-muted/50 rounded-lg p-3 mb-6 text-sm text-muted-foreground">
            Pour la sécurité de tous, un <strong>parent ou tuteur légal</strong> doit compléter les étapes suivantes avant de pouvoir utiliser l'application.
          </div>

          {/* Progress steps */}
          <div className="flex items-center gap-2 mb-6">
            <div className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full ${step === 'pin' ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary'}`}>
              <Lock className="w-3 h-3" />
              1. Code parental
            </div>
            <div className="h-px flex-1 bg-border" />
            <div className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full ${step === 'id' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
              <Upload className="w-3 h-3" />
              2. Pièce d'identité
            </div>
          </div>

          {step === 'pin' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Un parent doit définir un <strong>code PIN à 8 chiffres minimum</strong> pour le contrôle parental.
              </p>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Code PIN</Label>
                  <Input
                    type={showPin ? 'text' : 'password'}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
                    placeholder="8 chiffres min."
                    maxLength={12}
                    className="text-center text-lg tracking-[0.3em] font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Confirmer</Label>
                  <Input
                    type={showPin ? 'text' : 'password'}
                    value={pinConfirm}
                    onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, '').slice(0, 12))}
                    placeholder="8 chiffres min."
                    maxLength={12}
                    className="text-center text-lg tracking-[0.3em] font-mono"
                  />
                </div>
              </div>

              <button type="button" onClick={() => setShowPin(!showPin)} className="text-xs text-primary hover:underline">
                {showPin ? 'Masquer' : 'Afficher'} le code
              </button>

              <Button onClick={handlePinSubmit} disabled={isSubmittingPin || pin.length < 8} className="w-full pulse-button-gradient">
                {isSubmittingPin ? 'Enregistrement…' : 'Définir le code parental'}
              </Button>
            </motion.div>
          )}

          {step === 'id' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Veuillez envoyer une <strong>pièce d'identité</strong> (carte d'identité, passeport) pour vérifier votre âge.
              </p>

              <label className="flex flex-col items-center gap-3 p-6 border-2 border-dashed border-primary/30 rounded-xl cursor-pointer hover:border-primary/60 transition-colors">
                <Upload className="w-8 h-8 text-primary" />
                <span className="text-sm font-medium text-foreground">
                  {isUploadingId ? 'Envoi en cours…' : 'Cliquez pour uploader'}
                </span>
                <span className="text-xs text-muted-foreground">JPG, PNG ou PDF — Max 10 Mo</span>
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  onChange={handleIdUpload}
                  disabled={isUploadingId}
                  className="hidden"
                />
              </label>
            </motion.div>
          )}

          <div className="mt-6 pt-4 border-t border-border">
            <Button variant="ghost" size="sm" onClick={() => signOut()} className="w-full text-muted-foreground">
              Se déconnecter
            </Button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
