import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Timer, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface DisappearingMessagesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
}

const OPTIONS: Array<{ value: string; label: string; seconds: number | null }> = [
  { value: 'off', label: 'Désactivé', seconds: null },
  { value: '24h', label: '24 heures', seconds: 86400 },
  { value: '7d', label: '7 jours', seconds: 604800 },
  { value: '30d', label: '30 jours', seconds: 2592000 },
];

export function DisappearingMessagesDialog({ open, onOpenChange, conversationId }: DisappearingMessagesDialogProps) {
  const [current, setCurrent] = useState<string>('off');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    (async () => {
      const { data } = await supabase
        .from('conversations')
        .select('disappearing_seconds')
        .eq('id', conversationId)
        .maybeSingle();
      const secs = (data as any)?.disappearing_seconds ?? null;
      const match = OPTIONS.find(o => o.seconds === secs);
      setCurrent(match?.value ?? 'off');
      setLoading(false);
    })();
  }, [open, conversationId]);

  const save = async () => {
    setSaving(true);
    const opt = OPTIONS.find(o => o.value === current);
    const { error } = await supabase
      .from('conversations')
      .update({ disappearing_seconds: opt?.seconds ?? null } as any)
      .eq('id', conversationId);
    setSaving(false);
    if (error) {
      toast.error('Échec de la mise à jour');
      return;
    }
    toast.success(opt?.seconds ? `Messages éphémères : ${opt.label}` : 'Messages éphémères désactivés');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Timer className="w-5 h-5" />
            Messages éphémères
          </DialogTitle>
          <DialogDescription>
            Les nouveaux messages disparaîtront automatiquement après la durée choisie. Les messages déjà envoyés ne sont pas affectés.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <RadioGroup value={current} onValueChange={setCurrent} className="py-2">
            {OPTIONS.map(opt => (
              <div key={opt.value} className="flex items-center space-x-3 py-1.5">
                <RadioGroupItem value={opt.value} id={`disappear-${opt.value}`} />
                <Label htmlFor={`disappear-${opt.value}`} className="cursor-pointer flex-1">
                  {opt.label}
                </Label>
              </div>
            ))}
          </RadioGroup>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Annuler
          </Button>
          <Button onClick={save} disabled={loading || saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
