import { useCallback, useEffect, useState } from 'react';
import { Loader2, MapPin, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import {
  decidePendingLoginSecuritySession,
  listPendingLoginSecuritySessions,
  type PendingLoginSecuritySession,
} from '@/lib/security/loginSecurity';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

function locationLabel(session: PendingLoginSecuritySession): string {
  return [session.city, session.region, session.countryCode].filter(Boolean).join(', ')
    || 'Localisation indisponible';
}

export function LoginApprovalInbox() {
  const { user, loginSecurity } = useAuth();
  const [pending, setPending] = useState<PendingLoginSecuritySession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user || loginSecurity.status !== 'approved') return;
    try {
      const sessions = await listPendingLoginSecuritySessions();
      setPending((current) => {
        if (current && sessions.some((session) => session.sessionId === current.sessionId)) return current;
        return sessions[0] || null;
      });
    } catch {
      // A pre-rollout session may not have a login-security row yet. The next
      // normal assessment/refresh will make the inbox available.
    }
  }, [loginSecurity.status, user]);

  useEffect(() => {
    if (!user || loginSecurity.status !== 'approved') {
      setPending(null);
      return;
    }
    const first = window.setTimeout(() => void refresh(), 2_500);
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [loginSecurity.status, refresh, user]);

  const decide = async (decision: 'approve' | 'deny') => {
    if (!user || !pending) return;
    setBusy(true);
    setError(null);
    try {
      await decidePendingLoginSecuritySession(user.id, pending.sessionId, decision);
      setPending(null);
      await refresh();
    } catch {
      setError('La preuve de cet appareil n’a pas pu être vérifiée. Réessayez après avoir déverrouillé Aegis.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(pending)} onOpenChange={(open) => !open && setPending(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-500" />
            Nouvelle connexion à approuver
          </DialogTitle>
          <DialogDescription>
            Un autre navigateur demande l’accès à votre compte. Vérifiez les informations avant de répondre.
          </DialogDescription>
        </DialogHeader>

        {pending && (
          <div className="rounded-2xl border border-border/60 bg-muted/30 p-4 text-sm space-y-3">
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-4 w-4 text-primary" />
              <span>{pending.device || 'Nouvel appareil'}</span>
            </div>
            <div className="flex items-center gap-3">
              <MapPin className="h-4 w-4 text-primary" />
              <span>{locationLabel(pending)}</span>
            </div>
            {pending.createdAt && (
              <p className="text-xs text-muted-foreground">
                Demande reçue le {new Date(pending.createdAt).toLocaleString('fr-FR')}.
              </p>
            )}
          </div>
        )}

        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="destructive" disabled={busy} onClick={() => void decide('deny')}>
            {busy ? <Loader2 className="animate-spin" /> : <ShieldAlert />}
            Ce n’est pas moi
          </Button>
          <Button disabled={busy} onClick={() => void decide('approve')}>
            {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            C’est bien moi
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
