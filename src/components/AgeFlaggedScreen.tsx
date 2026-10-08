import { useState } from 'react';
import { Shield, Upload, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import BrandLogo from '@/components/BrandLogo';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { motion } from 'framer-motion';

const MAX_ID_DOCUMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_ID_DOCUMENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

/**
 * Blocking screen shown only when an explicit age-review state exists.
 * The identity document remains private and the server owns every status change.
 */
export function AgeFlaggedScreen() {
  const { user, signOut } = useAuth();
  const [isUploadingId, setIsUploadingId] = useState(false);
  const [idUploaded, setIdUploaded] = useState(false);

  const handleIdUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    if (!ALLOWED_ID_DOCUMENT_TYPES.has(file.type)) {
      toast({ title: 'Format non accepté', description: 'Utilisez un fichier JPG, PNG, WEBP ou PDF.', variant: 'destructive' });
      e.target.value = '';
      return;
    }

    if (file.size > MAX_ID_DOCUMENT_BYTES) {
      toast({ title: 'Fichier trop volumineux', description: 'Maximum 10 Mo.', variant: 'destructive' });
      e.target.value = '';
      return;
    }

    setIsUploadingId(true);
    try {
      const extension = file.type === 'application/pdf' ? 'pdf'
        : file.type === 'image/png' ? 'png'
          : file.type === 'image/webp' ? 'webp'
            : 'jpg';
      const objectPath = `${user.id}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase.storage
        .from('id-documents')
        .upload(objectPath, file, {
          contentType: file.type || 'image/jpeg',
          upsert: false,
        });
      if (uploadError) throw uploadError;

      const { data: signed, error: signedError } = await supabase.storage
        .from('id-documents')
        .createSignedUrl(objectPath, 10 * 60);
      if (signedError || !signed?.signedUrl) throw signedError || new Error('Lien de vérification indisponible');

      // 🔒 AI verification: detect fake / AI-generated documents
      const { data: verifyResult, error: verifyError } = await supabase.functions.invoke('verify-id-document', {
        body: { imageUrl: signed.signedUrl },
      });

      if (verifyError) {
        console.warn('Document verification error:', verifyError);
        // Don't block on verification error — proceed with manual review
      } else if (verifyResult && !verifyResult.valid) {
        // Document rejected by AI
        const reason = verifyResult.reason || 'Document suspect détecté';
        const details = verifyResult.details || {};

        let description = reason;
        if (details.is_ai_generated) {
          description = '🚨 Ce document semble avoir été généré par une intelligence artificielle. Veuillez fournir un vrai document.';
        } else if (details.is_manipulated) {
          description = '🚨 Ce document semble avoir été modifié ou falsifié. Veuillez fournir un document original.';
        } else if (details.is_screen_photo) {
          description = '📱 Veuillez photographier directement votre document, pas un écran.';
        } else if (!details.is_valid_format) {
          description = '❌ Ce document ne correspond pas à un format officiel reconnu.';
        }

        toast({
          title: 'Document rejeté',
          description,
          variant: 'destructive',
          duration: 10000,
        });
        setIsUploadingId(false);
        // Reset the input
        e.target.value = '';
        return;
      }

      // Store only the private object path. The RPC owns all status changes.
      const { error } = await (supabase.rpc as any)('submit_own_identity_document', {
        p_document_path: objectPath,
      });
      if (error) throw error;

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
              En attendant, votre compte reste protégé pendant la revue d’identité.
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
            Pour corriger cette vérification, envoyez une pièce d’identité. Aucun contrôle parental ne sera créé sur votre compte.
          </div>

          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Veuillez envoyer une <strong>pièce d'identité</strong> (carte d'identité, passeport) pour vérifier votre âge.
            </p>

            <label className="flex flex-col items-center gap-3 p-6 border-2 border-dashed border-primary/30 rounded-xl cursor-pointer hover:border-primary/60 transition-colors">
              <Upload className="w-8 h-8 text-primary" />
              <span className="text-sm font-medium text-foreground">
                {isUploadingId ? 'Envoi en cours…' : 'Cliquez pour uploader'}
              </span>
              <span className="text-xs text-muted-foreground">JPG, PNG, WEBP ou PDF — Max 10 Mo</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={handleIdUpload}
                disabled={isUploadingId}
                className="hidden"
              />
            </label>
          </motion.div>

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
