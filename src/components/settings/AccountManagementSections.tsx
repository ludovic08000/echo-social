import { useState } from 'react';
import { Trash2, AlertTriangle, Download, FileText, Image, Lock } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { toast } from '@/hooks/use-toast';

export function AccountDeletionSection() {
  const { user } = useAuth();
  const [confirmText, setConfirmText] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleRequestDeletion = async () => {
    if (!user || confirmText !== 'SUPPRIMER') return;
    setRequesting(true);
    try {
      const { error } = await supabase
        .from('account_deletion_requests')
        .insert({
          user_id: user.id,
          status: 'pending',
          reason: 'User requested deletion',
        } as any);
      if (error) throw error;
      toast({
        title: 'Demande de suppression enregistrée',
        description: 'Votre compte sera supprimé dans 30 jours. Vous pouvez annuler à tout moment en vous reconnectant.',
      });
      setConfirmText('');
      setDialogOpen(false);
    } catch (err: any) {
      console.error('Deletion request error:', err);
      toast({ title: 'Erreur', description: err?.message || 'Impossible de traiter votre demande.', variant: 'destructive' });
    } finally {
      setRequesting(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <Trash2 className="w-5 h-5 text-destructive" />
        <h3 className="font-semibold">Supprimer mon compte</h3>
      </div>
      <div className="pl-7">
        <div className="p-5 rounded-xl border-2 border-destructive/20 bg-destructive/5 space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">⚠️ Attention, cette action est sérieuse</p>
            <ul className="text-sm text-muted-foreground space-y-1.5 list-disc pl-4">
              <li>Vos données seront conservées <strong>30 jours</strong> après la demande</li>
              <li>Si vous vous reconnectez dans ce délai, la suppression sera <strong>annulée automatiquement</strong></li>
              <li>Passé 30 jours, <strong>toutes vos données</strong> seront définitivement effacées (profil, publications, messages, photos, vidéos)</li>
              <li>Nous vous recommandons de <strong>sauvegarder vos données</strong> avant de supprimer votre compte</li>
            </ul>
          </div>

          <AlertDialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setConfirmText(''); }}>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" className="gap-2">
                <AlertTriangle className="w-4 h-4" />
                Demander la suppression
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Supprimer définitivement votre compte ?</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-3">
                    <p>
                      Vos données seront conservées 30 jours. Si vous ne vous reconnectez pas durant cette période, 
                      tout sera supprimé de façon irréversible.
                    </p>
                    <p className="font-medium text-foreground">
                      Tapez <strong>SUPPRIMER</strong> pour confirmer :
                    </p>
                    <Input
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder="SUPPRIMER"
                      className="mt-2"
                    />
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={requesting}>Annuler</AlertDialogCancel>
                <Button
                  variant="destructive"
                  onClick={handleRequestDeletion}
                  disabled={confirmText !== 'SUPPRIMER' || requesting}
                >
                  {requesting ? 'Traitement…' : 'Confirmer la suppression'}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </section>
  );
}

export function DataExportSection() {
  const { user } = useAuth();
  const [exporting, setExporting] = useState<'basic' | 'full' | null>(null);

  const handleExport = async (type: 'basic' | 'full') => {
    if (!user) return;
    setExporting(type);
    try {
      await supabase.auth.refreshSession();
      const { data, error } = await supabase.functions.invoke('data-export', {
        body: { type },
      });
      if (error) throw error;

      if (type === 'full' && data?.checkout_url) {
        // Redirect to payment for full export
        window.location.href = data.checkout_url;
        return;
      }

      if (data?.download_url) {
        // Direct download for basic export
        const link = document.createElement('a');
        link.href = data.download_url;
        link.download = `forsure-export-${new Date().toISOString().split('T')[0]}.json`;
        link.click();
        toast({ title: 'Export téléchargé avec succès' });
      } else if (data?.message) {
        toast({ title: data.message });
      }
    } catch {
      toast({ title: 'Erreur lors de l\'export', variant: 'destructive' });
    } finally {
      setExporting(null);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <Download className="w-5 h-5 text-primary" />
        <h3 className="font-semibold">Sauvegarder mes données</h3>
      </div>
      <div className="pl-7 space-y-3">
        <p className="text-xs text-muted-foreground">
          Téléchargez une copie de vos données conformément au RGPD.
        </p>

        {/* Basic Export - Free */}
        <div className="p-4 rounded-xl border border-border/50 bg-secondary/20 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-primary" />
              <span className="text-sm font-semibold">Export basique</span>
              <Badge variant="secondary" className="text-xs">Gratuit</Badge>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Profil, liste d'amis, publications (texte), commentaires, paramètres.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            onClick={() => handleExport('basic')}
            disabled={exporting !== null}
          >
            <Download className="w-3.5 h-3.5" />
            {exporting === 'basic' ? 'Génération…' : 'Télécharger (JSON)'}
          </Button>
        </div>

        {/* Full Export - Paid */}
        <div className="p-4 rounded-xl border border-primary/30 bg-primary/5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Image className="w-4 h-4 text-primary" />
              <span className="text-sm font-semibold">Export complet</span>
              <Badge className="text-xs bg-primary/20 text-primary border-primary/30">4,99 €</Badge>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Tout le contenu : profil, publications, messages privés, photos, vidéos, commentaires, paramètres et liste d'amis.
          </p>
          <Button
            size="sm"
            className="gap-2"
            onClick={() => handleExport('full')}
            disabled={exporting !== null}
          >
            <Lock className="w-3.5 h-3.5" />
            {exporting === 'full' ? 'Redirection…' : 'Acheter & télécharger'}
          </Button>
        </div>
      </div>
    </section>
  );
}
