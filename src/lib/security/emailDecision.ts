import { readCurrentLoginSecuritySession } from './loginSecurity';

export interface EmailDecisionPayload { token: string; decision: 'approve' | 'deny' }
export type EmailDecisionOutcome = 'same_session' | 'other_session' | 'denied'
  | 'device_approved_same_session' | 'device_approved_other_session';

export async function completeEmailDecision(payload: EmailDecisionPayload): Promise<EmailDecisionOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/login-security`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ action: 'email_decision', ...payload }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      throw new Error('LOGIN_EMAIL_DECISION_UNAVAILABLE');
    }
    const result = await response.json();
    if (result.ok !== true || result.decision !== payload.decision
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.targetSessionId ?? '')) {
      throw new Error('LOGIN_EMAIL_DECISION_INVALID');
    }
    // Un lien confirme sa session d'origine. Il ne transfère jamais cette
    // autorisation au navigateur de messagerie qui vient d'ouvrir le lien.
    if (payload.decision === 'deny') return 'denied';
    let readTimeout: ReturnType<typeof setTimeout> | undefined;
    const current = await Promise.race([
      readCurrentLoginSecuritySession().catch(() => null),
      new Promise<null>((resolve) => { readTimeout = setTimeout(() => resolve(null), 5_000); }),
    ]).finally(() => clearTimeout(readTimeout));
    const sameSession = current?.status === 'approved' && current.sessionId === result.targetSessionId;
    if (result.deviceApprovalStatus === 'approved') {
      return sameSession ? 'device_approved_same_session' : 'device_approved_other_session';
    }
    return sameSession ? 'same_session' : 'other_session';
  } finally {
    clearTimeout(timeout);
  }
}
