// Invariant : le journal ne reçoit ni corps HTTP, ni erreur libre, ni clé.
const EVENTS = new Set([
  'approval_email_requested', 'approval_email_queued', 'approval_email_queue_failed',
  'approval_email_provider_started', 'approval_email_provider_accepted', 'approval_email_provider_failed',
  'login_decision', 'email_token_consume', 'login_device_binding', 'login_assessment', 'approval_email',
]);
const OUTCOMES = new Set(['start', 'info', 'success', 'failure']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createAegisJourney({ logger = r => console.log(JSON.stringify(r)), now = Date.now } = {}) {
  const requestId = globalThis.crypto.randomUUID();
  const started = now();
  let sequence = 0;
  return (event, outcome, sessionId = null) => {
    if (!EVENTS.has(event) || !OUTCOMES.has(outcome)) return;
    const time = now();
    const record = {
      event: 'aegis_journey', schema_version: 1, timestamp: new Date(time).toISOString(),
      service: 'lovable-cloud', stage: event, outcome,
      request_id: requestId, sequence: ++sequence, elapsed_ms: Math.max(0, time - started),
      // Session cible issue du serveur ; jamais le token du lien ni un en-tête libre.
      session_id: typeof sessionId === 'string' && UUID.test(sessionId) ? sessionId : null,
    };
    try { logger(record); } catch { /* L'observation ne bloque pas la connexion. */ }
    return record;
  };
}

export function approvalEmailSession(messageId) {
  if (typeof messageId !== 'string') return null;
  const match = /^login-security:([0-9a-f-]{36}):[0-9a-f]{16}$/.exec(messageId);
  return match && UUID.test(match[1]) ? match[1] : null;
}
