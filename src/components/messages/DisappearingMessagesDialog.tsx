import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Timer, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { RETENTION_OPTIONS as OPTIONS, retentionConfirmed } from '@/lib/messaging/messageRetention';

interface DisappearingMessagesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
}

export function DisappearingMessagesDialog({ open, onOpenChange, conversationId }: DisappearingMessagesDialogProps) {
  const [current, setCurrent] = useState<string>('never');
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(open);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    (async () => {
      try {
      const { data, error } = await supabase
        .from('conversations')
        .select('disappearing_seconds, disappearing_after_read')
        .eq('id', conversationId)
        .maybeSingle();
      if (cancelled) return;
      if (error || !data) throw error ?? new Error('CONVERSATION_NOT_FOUND');
      const row = data as unknown as { disappearing_seconds: number | null; disappearing_after_read: boolean };
      const secs = row.disappearing_seconds;
      const match = OPTIONS.find(o => o.seconds === secs);
      setCurrent(!row.disappearing_after_read && secs !== null ? 'legacy' : match?.value ?? 'legacy');
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, conversationId]);

  const save = async () => {
    const opt = OPTIONS.find(o => o.value === current);
    if (!opt || loading || loadError || saving) return;
    setSaving(true);
    try {
    const { data, error } = await supabase.rpc('set_conversation_retention' as never, {
      p_conversation_id: conversationId, p_seconds: opt.seconds,
    } as never);
    if (error || !retentionConfirmed(data, opt.seconds)) throw error ?? new Error('RETENTION_UNCONFIRMED');
    toast.success(opt.seconds === null ? 'Suppression automatique désactivée' : `Suppression : ${opt.label}`);
    onOpenChange(false);
    } catch {
      toast.error('Échec de la mise à jour');
    } finally {
      setSaving(false);
    }
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
            Le délai commence après la lecture confirmée du destinataire (de tous les destinataires dans un groupe).
            Ce réglage partagé concerne uniquement les nouveaux messages. Les anciens messages ne changent pas.
            Une capture d’écran ou une copie externe ne peut pas être effacée.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <p role="alert">Impossible de charger le réglage. Ferme puis rouvre cette fenêtre pour réessayer.</p>
        ) : (
          <>
          {current === 'legacy' && <p role="status">Ancien délai après envoi actif. Choisis une option pour passer à la suppression après lecture.</p>}
          <RadioGroup value={current} onValueChange={setCurrent} disabled={saving} className="py-2">
            {OPTIONS.map(opt => (
              <div key={opt.value} className="flex items-center space-x-3 py-1.5">
                <RadioGroupItem value={opt.value} id={`disappear-${opt.value}`} />
                <Label htmlFor={`disappear-${opt.value}`} className="cursor-pointer flex-1">
                  {opt.label}
                </Label>
              </div>
            ))}
          </RadioGroup>
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Annuler
          </Button>
          <Button onClick={save} disabled={loading || saving || loadError || !OPTIONS.some(o => o.value === current)}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
