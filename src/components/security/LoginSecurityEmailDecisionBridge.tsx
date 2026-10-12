import { useEffect, useRef, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { completeEmailDecision, type EmailDecisionOutcome } from '@/lib/security/emailDecision';

type EmailDecision = 'approve' | 'deny';

interface DecisionPayload {
  token: string;
  decision: EmailDecision;
}

const TOKEN_RE = /^[a-f0-9]{64}$/;

function readDecisionPayload(): DecisionPayload | 'invalid' | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get('loginSecurityToken');
  const decision = params.get('loginSecurityDecision');
  if (!token && !decision) return null;
  if (!token || !TOKEN_RE.test(token) || (decision !== 'approve' && decision !== 'deny')) {
    return 'invalid';
  }
  return { token, decision };
}

/**
 * Completes the read-only e-mail redirect on the trusted ForSure origin.
 * Le token quitte l'historique avant le POST. Pas de rechargement supplémentaire
 * qui détruirait les clés temporaires encore présentes dans ce navigateur.
 */
export function LoginSecurityEmailDecisionBridge() {
  const [payload] = useState<DecisionPayload | 'invalid' | null>(() => readDecisionPayload());
  const [outcome, setOutcome] = useState<EmailDecisionOutcome | 'error' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const request = useRef<Promise<EmailDecisionOutcome> | null>(null);

  useEffect(() => {
    if (!payload || payload === 'invalid') return;
    let cancelled = false;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    request.current ??= completeEmailDecision(payload);
    void request.current.then((result) => {
      if (cancelled) return;
      setOutcome(result);
      window.dispatchEvent(new Event('forsure:login-security-changed'));
    }).catch(() => { if (!cancelled) setOutcome('error'); });
    return () => { cancelled = true; };
  }, [payload, attempt]);

  if (!payload || outcome === 'same_session') return null;
  const invalid = payload === 'invalid';
  const waiting = !invalid && outcome === null;
  return (
    <div className="fixed inset-0 z-[1000] grid place-items-center bg-background p-6" role="dialog" aria-modal="true" aria-labelledby="email-decision-title">
      <div className="max-w-md text-center" aria-live="polite">
        {waiting ? <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-primary" />
          : <ShieldCheck className="mx-auto mb-4 h-12 w-12 text-primary" />}
        <h1 id="email-decision-title" className="text-xl font-semibold text-foreground">
          {invalid || outcome === 'error' ? 'Validation non confirmée'
            : outcome === 'other_session' ? 'Connexion confirmée'
            : outcome === 'denied' ? 'Connexion refusée' : 'Validation de votre connexion…'}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {outcome === 'other_session'
            ? 'Revenez dans le navigateur ou l’application où vous avez commencé la connexion. La validation y sera reprise automatiquement. Ce lien ne connecte pas un autre navigateur à votre place.'
            : outcome === 'denied' ? 'La demande de connexion a été refusée.'
            : invalid ? 'Ce lien est incomplet. Ouvrez le lien complet du dernier e-mail ForSure.'
            : outcome === 'error' ? 'Le serveur n’a pas confirmé la décision. Réessayez ; si le lien a expiré, demandez un nouvel e-mail depuis la connexion d’origine.'
            : 'ForSure vérifie la demande d’origine, sans remplacer vos clés.'}
        </p>
        {outcome === 'error' && <Button className="mt-6" onClick={() => {
          request.current = null;
          setOutcome(null);
          setAttempt((value) => value + 1);
        }}>Réessayer</Button>}
        {!waiting && <a href="/feed" className="mt-6 block text-sm text-primary underline">Ouvrir ForSure dans ce navigateur</a>}
      </div>
    </div>
  );
}
