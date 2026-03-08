import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Heart, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';

interface TipButtonProps {
  creatorId: string;
  creatorName: string;
}

export function TipButton({ creatorId, creatorName }: TipButtonProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleTip = async () => {
    const numAmount = parseFloat(amount);
    if (!numAmount || numAmount < 1) {
      toast.error('Montant minimum : 1€');
      return;
    }
    if (!user) {
      toast.error('Connectez-vous pour envoyer un tip');
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-tip', {
        body: { amount: numAmount, creator_id: creatorId, message },
      });

      if (error) throw error;
      if (data?.url) {
        window.open(data.url, '_blank');
        setOpen(false);
        setAmount('');
        setMessage('');
      }
    } catch (e: any) {
      toast.error(e.message || 'Erreur lors du paiement');
    } finally {
      setLoading(false);
    }
  };

  const presetAmounts = [2, 5, 10, 20];

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="rounded-xl gap-1.5 border-pink-500/30 text-pink-500 hover:bg-pink-500/10 hover:text-pink-500"
        onClick={() => setOpen(true)}
      >
        <Heart className="w-4 h-4" />
        Tip
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Heart className="w-5 h-5 text-pink-500" />
              Envoyer un tip à {creatorName}
            </DialogTitle>
            <DialogDescription>
              Soutenez ce créateur avec un tip. 15% de frais de service.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 pt-2">
            {/* Preset amounts */}
            <div className="flex gap-2">
              {presetAmounts.map((preset) => (
                <Button
                  key={preset}
                  variant={amount === preset.toString() ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1 rounded-xl"
                  onClick={() => setAmount(preset.toString())}
                >
                  {preset}€
                </Button>
              ))}
            </div>

            {/* Free amount */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">Montant libre</label>
              <div className="relative">
                <Input
                  type="number"
                  min="1"
                  step="0.01"
                  placeholder="Montant en €"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="pr-8 rounded-xl"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">€</span>
              </div>
            </div>

            {/* Message */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">Message (optionnel)</label>
              <Textarea
                placeholder="Un petit mot pour le créateur..."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={200}
                className="rounded-xl resize-none"
                rows={2}
              />
            </div>

            {/* Summary */}
            {amount && parseFloat(amount) >= 1 && (
              <div className="rounded-xl bg-secondary/50 p-3 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tip</span>
                  <span>{parseFloat(amount).toFixed(2)}€</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Frais (15%)</span>
                  <span>{(parseFloat(amount) * 0.15).toFixed(2)}€</span>
                </div>
                <div className="flex justify-between font-bold pt-1 border-t border-border/50">
                  <span>{creatorName} reçoit</span>
                  <span>{(parseFloat(amount) * 0.85).toFixed(2)}€</span>
                </div>
              </div>
            )}

            <Button
              onClick={handleTip}
              disabled={loading || !amount || parseFloat(amount) < 1}
              className="w-full rounded-xl bg-pink-500 hover:bg-pink-600 text-white"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Heart className="w-4 h-4 mr-2" />}
              Envoyer {amount ? `${parseFloat(amount).toFixed(2)}€` : 'un tip'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
