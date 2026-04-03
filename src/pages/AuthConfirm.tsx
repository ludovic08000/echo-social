import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import BrandLogo from '@/components/BrandLogo';
import { CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function AuthConfirm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');

  useEffect(() => {
    const checkConfirmation = async () => {
      // Small delay to let Supabase process the token from the URL hash
      await new Promise(r => setTimeout(r, 1500));

      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        // Check if profile has onboarding_completed
        const { data: profile } = await supabase
          .from('profiles')
          .select('onboarding_completed')
          .eq('user_id', session.user.id)
          .single();

        setStatus('success');

        setTimeout(() => {
          if (profile && !profile.onboarding_completed) {
            navigate('/onboarding', { replace: true });
          } else {
            navigate('/feed', { replace: true });
          }
        }, 2000);
      } else {
        // No session yet — user likely needs to go to login
        setStatus('success');
        setTimeout(() => navigate('/login?confirmed=1', { replace: true }), 2000);
      }
    };

    checkConfirmation();
  }, [navigate, searchParams]);

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4">
      <BrandLogo className="h-12 w-auto mb-8" />

      <div className="pulse-card p-8 max-w-sm w-full text-center">
        {status === 'loading' && (
          <>
            <Loader2 className="w-12 h-12 text-primary animate-spin mx-auto mb-4" />
            <h1 className="text-xl font-bold mb-2">Vérification en cours…</h1>
            <p className="text-sm text-muted-foreground">Nous confirmons votre adresse e-mail.</p>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle className="w-12 h-12 text-green-500 mx-auto mb-4" />
            <h1 className="text-xl font-bold mb-2">E-mail confirmé ✅</h1>
            <p className="text-sm text-muted-foreground mb-4">Votre compte est vérifié. Redirection en cours…</p>
            <Button onClick={() => navigate('/login', { replace: true })} variant="outline" size="sm">
              Aller à la connexion
            </Button>
          </>
        )}

        {status === 'error' && (
          <>
            <AlertCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
            <h1 className="text-xl font-bold mb-2">Erreur de confirmation</h1>
            <p className="text-sm text-muted-foreground mb-4">Le lien est peut-être expiré. Veuillez réessayer.</p>
            <Button onClick={() => navigate('/login', { replace: true })} variant="outline" size="sm">
              Retour à la connexion
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
