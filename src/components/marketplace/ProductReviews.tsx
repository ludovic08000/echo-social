import { useState } from 'react';
import { useProductReviews, useCreateReview } from '@/hooks/useProductReviews';
import { useAuth } from '@/lib/auth';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';

function StarRating({ rating, onRate, interactive = false }: { rating: number; onRate?: (r: number) => void; interactive?: boolean }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          disabled={!interactive}
          onClick={() => onRate?.(star)}
          className={cn('transition-colors', interactive && 'cursor-pointer hover:scale-110')}
        >
          <Star
            className={cn(
              'w-4 h-4',
              star <= rating ? 'fill-primary text-primary' : 'text-muted-foreground/30'
            )}
          />
        </button>
      ))}
    </div>
  );
}

export function ProductReviews({ productId }: { productId: string }) {
  const { user } = useAuth();
  const { data: reviews = [], isLoading } = useProductReviews(productId);
  const createReview = useCreateReview();
  const [showForm, setShowForm] = useState(false);
  const [rating, setRating] = useState(5);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const handleSubmit = () => {
    if (rating < 1) return;
    createReview.mutate(
      { productId, rating, title: title.trim() || undefined, body: body.trim() || undefined },
      {
        onSuccess: () => {
          setShowForm(false);
          setRating(5);
          setTitle('');
          setBody('');
        },
      }
    );
  };

  const avgRating = reviews.length > 0
    ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
    : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">Avis</h2>
          {reviews.length > 0 && (
            <span className="text-sm text-muted-foreground">
              ({avgRating.toFixed(1)} · {reviews.length} avis)
            </span>
          )}
        </div>
        {user && !showForm && (
          <Button variant="outline" size="sm" onClick={() => setShowForm(true)} className="text-xs">
            Donner un avis
          </Button>
        )}
      </div>

      {showForm && (
        <div className="premium-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Votre note :</span>
            <StarRating rating={rating} onRate={setRating} interactive />
          </div>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Titre (optionnel)"
            className="text-sm"
          />
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Votre avis..."
            rows={3}
            className="text-sm"
          />
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Annuler</Button>
            <Button size="sm" onClick={handleSubmit} disabled={createReview.isPending}>
              {createReview.isPending ? 'Envoi...' : 'Publier'}
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => <div key={i} className="skeleton h-20 rounded-xl" />)}
        </div>
      ) : reviews.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">Aucun avis pour le moment</p>
      ) : (
        <div className="space-y-3">
          {reviews.map((review: any) => (
            <div key={review.id} className="premium-card p-3 space-y-2">
              <div className="flex items-center gap-2">
                <UserAvatar src={review.profiles?.avatar_url} alt={review.profiles?.name} size="sm" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{review.profiles?.name || 'Utilisateur'}</p>
                  <div className="flex items-center gap-2">
                    <StarRating rating={review.rating} />
                    <span className="text-[11px] text-muted-foreground">
                      {formatDistanceToNow(new Date(review.created_at), { addSuffix: true, locale: fr })}
                    </span>
                  </div>
                </div>
              </div>
              {review.title && <p className="text-sm font-medium">{review.title}</p>}
              {review.body && <p className="text-sm text-muted-foreground">{review.body}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
