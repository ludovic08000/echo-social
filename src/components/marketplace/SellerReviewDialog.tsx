import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCreateSellerReview } from '@/hooks/useSellerReviews';

interface SellerReviewDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sellerProfileId: string;
  orderId: string;
  sellerName?: string;
}

export function SellerReviewDialog({ open, onOpenChange, sellerProfileId, orderId, sellerName }: SellerReviewDialogProps) {
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState('');
  const createReview = useCreateSellerReview();

  const handleSubmit = () => {
    if (rating < 1) return;
    createReview.mutate(
      { sellerProfileId, orderId, rating, body: body.trim() || undefined },
      { onSuccess: () => { onOpenChange(false); setRating(5); setBody(''); } }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">Évaluer le vendeur{sellerName ? ` · ${sellerName}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">Note :</span>
            <div className="flex gap-0.5">
              {[1, 2, 3, 4, 5].map(s => (
                <button key={s} type="button" onClick={() => setRating(s)} className="hover:scale-110 transition-transform">
                  <Star className={cn('w-5 h-5', s <= rating ? 'fill-primary text-primary' : 'text-muted-foreground/30')} />
                </button>
              ))}
            </div>
          </div>
          <Textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Votre avis sur le vendeur (optionnel)..."
            rows={3}
            className="text-sm rounded-xl"
          />
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Annuler</Button>
            <Button size="sm" onClick={handleSubmit} disabled={createReview.isPending}>
              {createReview.isPending ? 'Envoi...' : 'Publier'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
