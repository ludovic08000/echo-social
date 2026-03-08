import { useState } from 'react';
import { ShieldAlert, AlertTriangle, MessageSquareWarning, Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useReportUser } from '@/hooks/useTrustAndSafety';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';

const REPORT_OPTIONS = [
  { type: 'harassment', icon: MessageSquareWarning, label: '😰 Harcèlement', description: 'Quelqu\'un me harcèle ou m\'insulte' },
  { type: 'suspicious_contact', icon: AlertTriangle, label: '⚠️ Message suspect', description: 'Un adulte me contacte de façon bizarre' },
  { type: 'inappropriate_content', icon: Ban, label: '🚫 Contenu choquant', description: 'J\'ai vu du contenu inapproprié' },
  { type: 'threat', icon: ShieldAlert, label: '🆘 Menace', description: 'Quelqu\'un me menace ou me fait peur' },
];

interface MinorReportButtonProps {
  reportedUserId?: string;
  className?: string;
}

export function MinorReportButton({ reportedUserId, className }: MinorReportButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const reportUser = useReportUser();
  const { user } = useAuth();

  const handleReport = async (reportType: string) => {
    if (!user || !reportedUserId) return;
    setLoading(true);
    try {
      await reportUser.mutateAsync({
        reportedUserId,
        reportType,
        description: `Signalement mineur: ${reportType}`,
      });
      toast.success('✅ Signalement envoyé ! Notre équipe va vérifier rapidement.');
      setOpen(false);
    } catch {
      toast.error('Erreur lors du signalement');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => setOpen(true)}
        className={className}
      >
        <ShieldAlert className="w-4 h-4 mr-1.5" />
        Signaler
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <ShieldAlert className="w-5 h-5" />
              Que se passe-t-il ?
            </DialogTitle>
            <DialogDescription>
              Choisis ce qui te correspond. Ton signalement est confidentiel.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {REPORT_OPTIONS.map((option) => (
              <button
                key={option.type}
                onClick={() => handleReport(option.type)}
                disabled={loading}
                className="w-full flex items-center gap-3 p-3 rounded-xl border border-border/50 hover:bg-destructive/10 hover:border-destructive/30 transition-colors text-left disabled:opacity-50"
              >
                <span className="text-2xl">{option.label.split(' ')[0]}</span>
                <div>
                  <p className="font-medium text-sm">{option.label.split(' ').slice(1).join(' ')}</p>
                  <p className="text-xs text-muted-foreground">{option.description}</p>
                </div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
