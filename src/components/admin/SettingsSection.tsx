import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

function R2CleanupButton() {
  const [cleaning, setCleaning] = useState(false);
  const [result, setResult] = useState<{ total_files: number; orphaned: number; deleted: number } | null>(null);

  const handleCleanup = async () => {
    setCleaning(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke('r2-cleanup');
      if (error) throw error;
      setResult(data);
      toast({ title: `Analyse terminée : ${data.orphaned} candidat(s) à examiner. Aucun fichier supprimé.` });
    } catch {
      toast({ title: 'Erreur lors du nettoyage', variant: 'destructive' });
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button variant="outline" onClick={handleCleanup} disabled={cleaning} className="gap-2">
        <RefreshCw className={cn("w-4 h-4", cleaning && "animate-spin")} />
        {cleaning ? 'Analyse en cours…' : 'Analyser sans supprimer'}
      </Button>
      {result && (
        <div className="text-xs text-muted-foreground space-y-0.5">
          <p>📁 Fichiers scannés : <strong>{result.total_files}</strong></p>
          <p>Candidats à examiner : <strong>{result.orphaned}</strong></p>
          <p>✅ Supprimés : <strong>{result.deleted}</strong></p>
        </div>
      )}
    </div>
  );
}

export function SettingsSection() {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-foreground">Paramètres</h2>
      <div className="grid gap-4">
        <Card><CardContent className="p-6"><h3 className="font-semibold text-foreground mb-2">Maintenance</h3><p className="text-sm text-muted-foreground mb-4">Activer le mode maintenance pour empêcher l'accès aux utilisateurs.</p><Button variant="outline">Activer la maintenance</Button></CardContent></Card>
        <Card><CardContent className="p-6"><h3 className="font-semibold text-foreground mb-2">Cache IA</h3><p className="text-sm text-muted-foreground mb-4">Vider le cache de modération IA pour forcer le recalcul.</p><Button variant="outline" onClick={async () => { await supabase.rpc('cleanup_ai_cache'); toast({ title: 'Cache vidé' }); }}>Vider le cache</Button></CardContent></Card>
        <Card><CardContent className="p-6"><h3 className="font-semibold text-foreground mb-2">Inventaire R2 sans suppression</h3><p className="text-sm text-muted-foreground mb-4">Analyse les références connues. Une absence de référence ne prouve pas qu’un fichier est inutilisé : les suppressions restent désactivées jusqu’à validation du catalogue complet.</p><R2CleanupButton /></CardContent></Card>
        <Card><CardContent className="p-6"><h3 className="font-semibold text-foreground mb-2">Plateforme</h3><p className="text-sm text-muted-foreground">Version ForSure Admin v1.0</p></CardContent></Card>
      </div>
    </div>
  );
}
