import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Gift, Loader2, Heart, Star, Flame, Crown, Diamond, Zap, Rocket, Music, Lock } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useIsCreatorRevenueEnabled } from '@/hooks/usePlatformStats';

interface TipButtonProps {
  creatorId: string;
  creatorName: string;
}

const GIFTS = [
  { emoji: '🌹', label: 'Rose', amount: 1, color: 'from-rose-500/20 to-pink-500/20 border-rose-500/30' },
  { emoji: '❤️', label: 'Cœur', amount: 2, color: 'from-red-500/20 to-rose-500/20 border-red-500/30' },
  { emoji: '⭐', label: 'Étoile', amount: 5, color: 'from-yellow-500/20 to-amber-500/20 border-yellow-500/30' },
  { emoji: '🔥', label: 'Flamme', amount: 10, color: 'from-orange-500/20 to-red-500/20 border-orange-500/30' },
  { emoji: '👑', label: 'Couronne', amount: 20, color: 'from-amber-500/20 to-yellow-500/20 border-amber-500/30' },
  { emoji: '💎', label: 'Diamant', amount: 50, color: 'from-cyan-500/20 to-blue-500/20 border-cyan-500/30' },
  { emoji: '🚀', label: 'Fusée', amount: 100, color: 'from-violet-500/20 to-purple-500/20 border-violet-500/30' },
  { emoji: '🦄', label: 'Licorne', amount: 200, color: 'from-fuchsia-500/20 to-pink-500/20 border-fuchsia-500/30' },
];

export function TipButton({ creatorId, creatorName }: TipButtonProps) {
  const { user } = useAuth();
  const { enabled: revenueEnabled } = useIsCreatorRevenueEnabled();
  const [open, setOpen] = useState(false);
  const [selectedGift, setSelectedGift] = useState<typeof GIFTS[0] | null>(null);
  const [customAmount, setCustomAmount] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!revenueEnabled) {
    return (
      <Button variant="ghost" size="sm" disabled className="gap-1.5 text-muted-foreground">
        <Lock className="w-4 h-4" />
        Tips bientôt
      </Button>
    );
  }

  const finalAmount = showCustom ? parseFloat(customAmount) : selectedGift?.amount || 0;
  const isValid = finalAmount >= 1;

  const handleTip = async () => {
    if (!isValid) {
      toast.error('Montant minimum : 1€');
      return;
    }
    if (!user) {
      toast.error('Connectez-vous pour envoyer un cadeau');
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-tip', {
        body: {
          amount: finalAmount,
          creator_id: creatorId,
          message: showCustom ? '' : `${selectedGift?.emoji} ${selectedGift?.label}`,
        },
      });

      if (error) throw error;
      if (data?.url) {
        window.open(data.url, '_blank');
        setOpen(false);
        setSelectedGift(null);
        setCustomAmount('');
        setShowCustom(false);
      }
    } catch (e: any) {
      toast.error(e.message || 'Erreur lors du paiement');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-10 w-10 rounded-full bg-pink-500/10 hover:bg-pink-500/20 text-pink-500"
        onClick={() => setOpen(true)}
      >
        <Gift className="w-5 h-5" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm p-0 overflow-hidden rounded-2xl border-border/30">
          {/* Header gradient */}
          <div className="bg-gradient-to-b from-pink-500/10 to-transparent px-5 pt-5 pb-3">
            <DialogHeader>
              <DialogTitle className="text-center text-base font-bold">
                Envoyer un cadeau à {creatorName}
              </DialogTitle>
            </DialogHeader>
          </div>

          <div className="px-4 pb-5 space-y-4">
            {/* Gift grid - TikTok style */}
            <div className="grid grid-cols-4 gap-2">
              {GIFTS.map((gift) => (
                <button
                  key={gift.label}
                  onClick={() => {
                    setSelectedGift(gift);
                    setShowCustom(false);
                  }}
                  className={cn(
                    'relative flex flex-col items-center gap-1 p-3 rounded-2xl border transition-all duration-200',
                    'bg-gradient-to-br hover:scale-105 active:scale-95',
                    gift.color,
                    selectedGift?.label === gift.label
                      ? 'ring-2 ring-pink-500 shadow-lg shadow-pink-500/20 scale-105'
                      : 'border-border/20'
                  )}
                >
                  <span className="text-2xl leading-none">{gift.emoji}</span>
                  <span className="text-[10px] font-medium text-muted-foreground leading-tight">{gift.label}</span>
                  <span className="text-[11px] font-bold text-foreground">{gift.amount}€</span>
                </button>
              ))}
            </div>

            {/* Custom amount toggle */}
            <button
              onClick={() => {
                setShowCustom(!showCustom);
                setSelectedGift(null);
              }}
              className={cn(
                'w-full text-center text-xs font-medium py-2 rounded-xl transition-colors',
                showCustom ? 'text-pink-500 bg-pink-500/10' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {showCustom ? '← Choisir un cadeau' : 'Montant personnalisé'}
            </button>

            {showCustom && (
              <div className="relative">
                <Input
                  type="number"
                  min="1"
                  step="0.01"
                  placeholder="Montant en €"
                  value={customAmount}
                  onChange={(e) => setCustomAmount(e.target.value)}
                  className="pr-8 rounded-xl text-center text-lg font-bold h-12"
                  autoFocus
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground font-bold">€</span>
              </div>
            )}

            {/* Summary + Send */}
            {isValid && (
              <div className="text-center space-y-1">
                <p className="text-xs text-muted-foreground">
                  {creatorName} reçoit <span className="font-bold text-foreground">{(finalAmount * 0.85).toFixed(2)}€</span>
                </p>
              </div>
            )}

            <Button
              onClick={handleTip}
              disabled={loading || !isValid}
              className="w-full rounded-xl h-12 text-base font-bold bg-gradient-to-r from-pink-500 to-rose-500 hover:from-pink-600 hover:to-rose-600 text-white shadow-lg shadow-pink-500/25 transition-all"
            >
              {loading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <>
                  <Gift className="w-5 h-5 mr-2" />
                  Envoyer {isValid ? `${finalAmount.toFixed(2)}€` : ''}
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
