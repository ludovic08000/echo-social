import { useEffect, useRef, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';

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
 * The token is removed from browser history before a native form navigation
 * sends it to the Edge Function, so it never enters React routing or telemetry.
 */
export function LoginSecurityEmailDecisionBridge() {
  const [payload] = useState<DecisionPayload | 'invalid' | null>(() => readDecisionPayload());
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!payload) return;
    if (payload === 'invalid') {
      window.location.replace('/login?loginSecurity=invalid');
      return;
    }

    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    const submit = window.setTimeout(() => formRef.current?.submit(), 0);
    return () => window.clearTimeout(submit);
  }, [payload]);

  if (!payload) return null;
  if (payload === 'invalid') {
    return (
      <div className="fixed inset-0 z-[1000] grid place-items-center bg-background p-6">
        <Loader2 className="h-10 w-10 animate-spin text-primary" aria-label="Lien en cours de vérification" />
      </div>
    );
  }

  const endpoint = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/login-security`;
  return (
    <div className="fixed inset-0 z-[1000] grid place-items-center bg-background p-6">
      <div className="max-w-md text-center">
        <ShieldCheck className="mx-auto mb-4 h-12 w-12 text-primary" />
        <h1 className="text-xl font-semibold text-foreground">Validation de votre identité…</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          ForSure applique votre décision et sécurise la connexion.
        </p>
        <form ref={formRef} method="post" action={endpoint} className="mt-6">
          <input type="hidden" name="action" value="email_decision" />
          <input type="hidden" name="token" value={payload.token} />
          <input type="hidden" name="decision" value={payload.decision} />
          <button type="submit" className="text-sm font-medium text-primary underline underline-offset-4">
            Continuer si la validation ne démarre pas
          </button>
        </form>
      </div>
    </div>
  );
}
