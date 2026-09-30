import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useReportUser } from '@/hooks/useTrustAndSafety';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const REASONS = [
  { type: 'racism', emoji: '🚫', label: 'Propos racistes ou haineux' },
  { type: 'fraud', emoji: '💸', label: 'Arnaque / fraude' },
  { type: 'harassment', emoji: '😰', label: 'Harcèlement ou insultes' },
  { type: 'threat', emoji: '🆘', label: 'Menaces ou violence' },
  { type: 'sexual_content', emoji: '🔞', label: 'Contenu sexuel non sollicité' },
  { type: 'spam', emoji: '📢', label: 'Spam ou publicité' },
  { type: 'impersonation', emoji: '🎭', label: 'Usurpation d’identité' },
  { type: 'other', emoji: '❓', label: 'Autre' },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reportedUserId: string;
  reportedName?: string;
}

export function ReportUserDialog({ open, onOpenChange, reportedUserId, reportedName }: Props) {
  const [reason, setReason] = useState<string | null>(null);
  const [details, setDetails] = useState('');
  const report = useReportUser();

  const submit = async () => {
    if (!reason) return;
    const label = REASONS.find((r) => r.type === reason)?.label ?? reason;
    try {
      await report.mutateAsync({
        reportedUserId,
        reportType: reason,
        description: `[Messagerie] ${label}${details.trim() ? ` — ${details.trim().slice(0, 500)}` : ''}`,
      });
      toast.success('Signalement envoyé. Notre équipe va l’examiner.');
      setReason(null);
      setDetails('');
      onOpenChange(false);
    } catch {
      toast.error('Impossible d’envoyer le signalement.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Signaler {reportedName || 'cette personne'}</DialogTitle>
          <DialogDescription>Choisissez le motif. Votre signalement est confidentiel.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 max-h-[50vh] overflow-y-auto">
          {REASONS.map((r) => (
            <button
              key={r.type}
              type="button"
              onClick={() => setReason(r.type)}
              className={cn(
                'w-full flex items-center gap-3 p-2.5 rounded-xl border text-left text-sm transition-colors',
                reason === r.type ? 'border-destructive bg-destructive/10' : 'border-border/50 hover:bg-muted',
              )}
            >
              <span className="text-lg">{r.emoji}</span>
              <span className="font-medium">{r.label}</span>
            </button>
          ))}
        </div>
        <Textarea
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          maxLength={500}
          placeholder="Détails (facultatif)"
          className="min-h-[70px]"
        />
        <Button variant="destructive" disabled={!reason || report.isPending} onClick={submit}>
          {report.isPending ? 'Envoi…' : 'Envoyer le signalement'}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
