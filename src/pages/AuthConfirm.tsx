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
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const checkConfirmation = async () => {
      try {
        // Check for error params in URL first (no need to wait)
        const hashParams = new URLSearchParams(window.location.hash.replace('#', '?'));
        const errorCode = searchParams.get('error_code') || hashParams.get('error_code');
        const errorDescription = searchParams.get('error_description') || hashParams.get('error_description');

        if (errorCode || errorDescription) {
          setErrorMessage(errorDescription?.replace(/\+/g, ' ') || 'Lien invalide ou expiré.');
          setStatus('error');
          return;
        }

        // Active polling: wait for session to be available (max ~10s)
        let session = null;
        for (let i = 0; i < 20; i++) {
          const { data, error: sessionError } = await supabase.auth.getSession();
          if (sessionError) {
            console.error('[AuthConfirm] Session error:', sessionError);
            setErrorMessage(sessionError.message || 'Erreur de vérification de session.');
            setStatus('error');
            return;
          }
          if (data.session?.user) {
            session = data.session;
            break;
          }
          await new Promise(r => setTimeout(r, 500));
        }

        if (session?.user) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('onboarding_completed')
            .eq('user_id', session.user.id)
            .single() as any;

          setStatus('success');

          setTimeout(() => {
            if (profile && !profile.onboarding_completed) {
              navigate('/onboarding', { replace: true });
            } else {
              navigate('/feed', { replace: true });
            }
          }, 2000);
        } else {
          // No session after polling — user confirmed but needs to log in
          setStatus('success');
          setTimeout(() => navigate('/login?confirmed=1', { replace: true }), 2000);
        }
      } catch (err: any) {
        console.error('[AuthConfirm] Unexpected error:', err);
        setErrorMessage(err?.message || 'Une erreur inattendue est survenue.');
        setStatus('error');
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
            <p className="text-sm text-muted-foreground mb-4">
              {errorMessage || 'Le lien est peut-être expiré. Veuillez réessayer.'}
            </p>
            <div className="space-y-2">
              <Button onClick={() => navigate('/login', { replace: true })} variant="outline" size="sm" className="w-full">
                Retour à la connexion
              </Button>
              <Button onClick={() => navigate('/signup', { replace: true })} variant="ghost" size="sm" className="w-full text-xs">
                Créer un nouveau compte
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
