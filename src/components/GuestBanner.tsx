import { useAuth } from '@/lib/auth';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowRight, Sparkles } from 'lucide-react';

/**
 * Sticky banner shown to guest/anonymous users while browsing.
 * Encourages signup without blocking the experience.
 */
export function GuestBanner() {
  const { user, loading } = useAuth();

  if (loading || user) return null;

  return (
    <div className="sticky top-0 z-50 bg-primary/95 backdrop-blur-sm text-primary-foreground px-4 py-2.5 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm font-medium min-w-0">
        <Sparkles className="w-4 h-4 shrink-0" />
        <span className="truncate">Bienvenue sur Forsure ! Inscrivez-vous pour publier et discuter.</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Link to="/login">
          <Button variant="ghost" size="sm" className="text-primary-foreground hover:bg-primary-foreground/10">
            Connexion
          </Button>
        </Link>
        <Link to="/signup">
          <Button size="sm" variant="secondary" className="gap-1">
            S'inscrire <ArrowRight className="w-3.5 h-3.5" />
          </Button>
        </Link>
      </div>
    </div>
  );
}
