import { useEffect, useRef, useState } from 'react';
import { CircleHelp, Loader2, ShieldCheck } from 'lucide-react';
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
  const deviceApproved = outcome === 'device_approved_same_session' || outcome === 'device_approved_other_session';
  // Une réponse perdue n'est ni un refus serveur ni une preuve d'approbation.
  const unknownDecisionMessage = !invalid && payload.decision === 'approve'
    ? 'La réponse de confirmation n’a pas pu être vérifiée ici. Votre connexion a peut-être déjà été approuvée. Revenez au navigateur où vous avez commencé la connexion : si votre messagerie fonctionne, aucune action supplémentaire n’est nécessaire. Sinon, réessayez ci-dessous ou demandez un nouvel e-mail depuis la connexion d’origine.'
    : 'La réponse du serveur n’a pas pu être vérifiée ici. Votre refus a peut-être déjà été enregistré, mais cet écran ne peut pas le confirmer. Réessayez ci-dessous pour vérifier votre décision.';
  return (
    <div className="fixed inset-0 z-[1000] grid place-items-center bg-background p-6" role="dialog" aria-modal="true" aria-labelledby="email-decision-title">
      <div className="max-w-md text-center" aria-live="polite">
        {waiting ? <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-primary" />
          : invalid || outcome === 'error' ? <CircleHelp className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
          : <ShieldCheck className="mx-auto mb-4 h-12 w-12 text-primary" />}
        <h1 id="email-decision-title" className="text-xl font-semibold text-foreground">
          {invalid ? 'Lien de confirmation incomplet'
            : deviceApproved ? 'Appareil approuvé'
            : outcome === 'error' ? 'Impossible de vérifier dans ce navigateur'
            : outcome === 'other_session' ? 'Connexion confirmée'
            : outcome === 'denied' ? 'Connexion refusée' : 'Validation de votre connexion…'}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {deviceApproved
            ? outcome === 'device_approved_same_session'
              ? 'Le serveur confirme que l’appareil associé à votre connexion est approuvé. Vous pouvez continuer sur ForSure.'
              : 'Le serveur confirme que l’appareil associé à votre connexion est approuvé. Revenez au navigateur ou à l’application où vous avez commencé la connexion. Ce lien ne connecte pas un autre navigateur à votre place.'
            : outcome === 'other_session'
            ? 'Revenez dans le navigateur ou l’application où vous avez commencé la connexion. La validation y sera reprise automatiquement. Ce lien ne connecte pas un autre navigateur à votre place.'
            : outcome === 'denied' ? 'La demande de connexion a été refusée.'
            : invalid ? 'Ce lien est incomplet. Ouvrez le lien complet du dernier e-mail ForSure.'
            : outcome === 'error' ? unknownDecisionMessage
            : 'ForSure vérifie la demande d’origine, sans remplacer vos clés.'}
        </p>
        {outcome === 'error' && <Button className="mt-6" onClick={() => {
          request.current = null;
          setOutcome(null);
          setAttempt((value) => value + 1);
        }}>Réessayer</Button>}
        {outcome === 'device_approved_same_session' && <Button className="mt-6" onClick={() => setOutcome('same_session')}>Continuer sur ForSure</Button>}
        {!waiting && <a href="/feed" className="mt-6 block text-sm text-primary underline">Ouvrir ForSure dans ce navigateur</a>}
      </div>
    </div>
  );
}
