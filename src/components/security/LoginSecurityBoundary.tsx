import { useEffect, useState, type ReactNode } from 'react';
import { Loader2, LockKeyhole, Mail, MapPin, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

function locationLabel(session: ReturnType<typeof useAuth>['loginSecurity']['session']): string {
  if (!session) return 'Localisation indisponible';
  return [session.city, session.region, session.countryCode].filter(Boolean).join(', ')
    || 'Localisation indisponible';
}

export function LoginSecurityBoundary({ children }: { children: ReactNode }) {
  const {
    user,
    loading,
    loginSecurity,
    refreshLoginSecurity,
    resendLoginApprovalEmail,
    signOut,
  } = useAuth();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!user || loginSecurity.status !== 'pending') return;
    let refreshInFlight = false;
    const refreshPending = () => {
      if (refreshInFlight || document.visibilityState === 'hidden') return;
      refreshInFlight = true;
      void refreshLoginSecurity()
        .catch(() => undefined)
        .finally(() => {
          refreshInFlight = false;
        });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshPending();
    };

    refreshPending();
    const timer = window.setInterval(refreshPending, 4_000);
    window.addEventListener('focus', refreshPending);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshPending);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [loginSecurity.status, refreshLoginSecurity, user]);

  // A valid auth session can render the application while the short login
  // assessment and the approved account restoration continue in background.
  // Security-sensitive services remain gated separately until both steps are
  // complete. Pending approval, denial and verification failures still block.
  if (
    !user
    || loginSecurity.status === 'checking'
    || loginSecurity.status === 'approved'
  ) {
    return <>{children}</>;
  }
  if (loading) return null;

  const refresh = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await refreshLoginSecurity();
    } catch {
      setMessage('La vérification reste indisponible. Réessayez dans quelques instants.');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await resendLoginApprovalEmail();
      setMessage('Un nouvel e-mail ForSure vient d’être demandé.');
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setMessage(code.includes('RATE_LIMITED')
        ? 'Un e-mail a déjà été envoyé. Attendez cinq minutes avant un nouvel envoi.'
        : 'L’e-mail n’a pas pu être renvoyé pour le moment.');
    } finally {
      setBusy(false);
    }
  };

  const denied = loginSecurity.status === 'denied';
  const failed = loginSecurity.status === 'error';

  return (
    <main className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-lg border-border/60 shadow-xl">
        <CardHeader className="text-center items-center">
          <div className={`mb-2 flex h-14 w-14 items-center justify-center rounded-2xl ${denied || failed ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>
            {denied || failed ? <ShieldAlert className="h-7 w-7" />
              : <LockKeyhole className="h-7 w-7" />}
          </div>
          <CardTitle>
            {denied ? 'Connexion bloquée'
              : failed ? 'Vérification indisponible'
              : 'Confirmez cette connexion'}
          </CardTitle>
          <CardDescription>
            {denied
              ? 'Cette session a été refusée et ne peut pas accéder au coffre Aegis.'
              : failed
                ? 'Par sécurité, le compte et les clés restent verrouillés tant que le serveur ne peut pas confirmer la session.'
                : 'Cet appareil ou cette zone ne correspond pas à vos connexions habituelles. Un e-mail de confirmation ForSure a été envoyé.'}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {!denied && !failed && (
            <div className="rounded-2xl border border-border/50 bg-muted/30 p-4 text-sm space-y-3">
              <div className="flex items-center gap-3">
                <ShieldCheck className="h-4 w-4 text-primary" />
                <span>{loginSecurity.session?.device || 'Nouvel appareil'}</span>
              </div>
              <div className="flex items-center gap-3">
                <MapPin className="h-4 w-4 text-primary" />
                <span>{locationLabel(loginSecurity.session)}</span>
              </div>
              <div className="flex items-center gap-3">
                <Mail className="h-4 w-4 text-primary" />
                <span>{user.email ? `Confirmation envoyée à ${user.email}` : 'Confirmation envoyée par e-mail'}</span>
              </div>
            </div>
          )}

          {message && <p className="text-sm text-center text-muted-foreground" role="status">{message}</p>}

          <div className="grid gap-3 sm:grid-cols-2">
            {!denied && (
              <Button onClick={refresh} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                Vérifier à nouveau
              </Button>
            )}
            {loginSecurity.status === 'pending' && (
              <Button variant="outline" onClick={resend} disabled={busy}>
                <Mail /> Renvoyer l’e-mail
              </Button>
            )}
            {(denied || failed) && (
              <Button variant="outline" onClick={() => void signOut()} disabled={busy}>
                Se déconnecter
              </Button>
            )}
          </div>

          {!denied && !failed && (
            <p className="text-xs text-center text-muted-foreground">
              Vous pouvez aussi approuver cette demande depuis un autre appareil ForSure déjà fiable.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
