import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';

/**
 * Hook for guest-browsing mode.
 * Returns a `requireAuth` guard: call it before any interactive action.
 * If the user is not logged in, they are redirected to /signup with a toast.
 * Returns `true` if authenticated, `false` otherwise.
 */
export function useRequireAuth() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  const requireAuth = useCallback(
    (actionLabel?: string) => {
      if (user) return true;
      toast.info(actionLabel || 'Créez un compte pour continuer', {
        description: 'Inscrivez-vous gratuitement pour accéder à cette fonctionnalité.',
        action: {
          label: "S'inscrire",
          onClick: () => navigate('/signup'),
        },
      });
      navigate('/signup', { state: { from: window.location.pathname } });
      return false;
    },
    [user, navigate]
  );

  const isGuest = !loading && !user;

  return { requireAuth, isGuest, user };
}
